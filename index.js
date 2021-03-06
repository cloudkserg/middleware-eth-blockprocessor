/**
 * Middleware service for handling emitted events on chronobank platform
 * @module Chronobank/eth-blockprocessor
 * @requires config
 * @requires models/blockModel
 * @requires services/blockProcessService
 */

const mongoose = require('mongoose'),
  config = require('./config'),
  Promise = require('bluebird');

mongoose.Promise = Promise;
mongoose.connect(config.mongo.data.uri, {useMongoClient: true});
mongoose.accounts = mongoose.createConnection(config.mongo.accounts.uri, {useMongoClient: true});

const blockModel = require('./models/blockModel'),
  _ = require('lodash'),
  bunyan = require('bunyan'),
  Web3 = require('web3'),
  web3Errors = require('web3/lib/web3/errors'),
  net = require('net'),
  amqp = require('amqplib'),
  log = bunyan.createLogger({name: 'app'}),
  filterTxsByAccountService = require('./services/filterTxsByAccountService'),
  blockProcessService = require('./services/blockProcessService');

[mongoose.accounts, mongoose.connection].forEach(connection =>
  connection.on('disconnected', function () {
    log.error('mongo disconnected!');
    process.exit(0);
  })
);

const init = async () => {

    let currentBlock = await blockModel.findOne({network: config.web3.network}).sort('-block');
    currentBlock = _.chain(currentBlock).get('block', 0).add(0).value();
    log.info(`search from block:${currentBlock} for network:${config.web3.network}`);

    let provider = new Web3.providers.IpcProvider(config.web3.uri, net);
    const web3 = new Web3();
    web3.setProvider(provider);

    web3.currentProvider.connection.on('end', () => {
      log.error('ipc process has finished!');
      process.exit(0);
    });

    let amqpInstance = await amqp.connect(config.rabbit.url)
      .catch(() => {
        log.error('rabbitmq process has finished!');
        process.exit(0);
      });

    let channel = await amqpInstance.createChannel();

    channel.on('close', () => {
      log.error('rabbitmq process has finished!');
      process.exit(0);
    });

    await channel.assertExchange('events', 'topic', {durable: false});

    web3.eth.filter('pending').watch(async (err, result) => {
      if (err)
        return;

      let tx = await Promise.promisify(web3.eth.getTransaction)(result);

      if (!_.has(tx, 'hash'))
        return;

      let receipt = Promise.promisify(web3.eth.getTransactionReceipt)(tx.hash);
      tx.logs = _.get(receipt, 'logs', []);

      let filteredTxs = await filterTxsByAccountService([tx]);

      for (let filteredTx of filteredTxs) {

        let addresses = _.chain([filteredTx.to, filteredTx.from])
          .union(filteredTx.logs.map(log => log.address))
          .uniq()
          .value();

        filteredTx = _.omit(filteredTx, ['blockHash', 'transactionIndex']);
        filteredTx.blockNumber = -1;
        for (let address of addresses)
          await channel.publish('events', `${config.rabbit.serviceName}_transaction.${address}`, new Buffer(JSON.stringify(filteredTx)));
      }

    });

    /**
     * Recursive routine for processing incoming blocks.
     * @return {undefined}
     */
    let processBlock = async () => {
      try {
        let filteredTxs = await Promise.resolve(blockProcessService(currentBlock, web3)).timeout(20000);

        for (let tx of filteredTxs) {
          let addresses = _.chain([tx.to, tx.from])
            .union(tx.logs.map(log => log.address))
            .uniq()
            .value();

          for (let address of addresses)
            await channel.publish('events', `${config.rabbit.serviceName}_transaction.${address}`, new Buffer(JSON.stringify(tx)));
        }

        await blockModel.findOneAndUpdate({network: config.web3.network}, {
          $set: {
            block: currentBlock,
            created: Date.now()
          }
        }, {upsert: true});

        currentBlock++;
        processBlock();
      } catch (err) {

        if (err instanceof Promise.TimeoutError)
          return processBlock();

        if (_.has(err, 'cause') && err.toString() === web3Errors.InvalidConnection('on IPC').toString())
          return process.exit(-1);

        if (_.get(err, 'code') === 0) {
          log.info(`await for next block ${currentBlock}`);
          return setTimeout(processBlock, 10000);
        }

        currentBlock++;
        processBlock();
      }
    };

    processBlock();

  }
;

module.exports = init();
