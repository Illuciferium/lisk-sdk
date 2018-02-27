/*
 * Copyright © 2018 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 */

'use strict';

const async = require('async');
const extend = require('extend');
const _ = require('lodash');
const constants = require('../helpers/constants.js');
const jobsQueue = require('../helpers/jobs_queue.js');
const bson = require('../helpers/bson.js');

// Private fields
let modules;
let library;
let self;
const __private = {};

/**
 * Main Broadcaster logic.
 * Initializes variables, sets Broadcast routes and timer based on
 * broadcast interval from config file.
 *
 * @class
 * @memberof logic
 * @see Parent: {@link logic}
 * @requires extend
 * @requires lodash
 * @requires helpers/constants
 * @requires helpers/jobs_queue
 * @requires helpers/bson
 * @param {Object} broadcasts
 * @param {boolean} force
 * @param {Peers} peers - Peers instance
 * @param {Transaction} transaction - Transaction instance
 * @param {Object} logger
 * @todo Add description for the params
 */
// Constructor
class Broadcaster {
	constructor(broadcasts, force, peers, transaction, logger) {
		library = {
			logger,
			logic: {
				peers,
				transaction,
			},
			config: {
				broadcasts,
				forging: {
					force,
				},
			},
		};

		self = this;

		self.queue = [];
		self.config = library.config.broadcasts;
		self.config.peerLimit = constants.maxPeers;
		// The below config parallelLimit, relayLimit was missing
		// so we need to see if it was missing and add specific numbers
		self.config.parallelLimit = 10;
		self.config.relayLimit = 10;

		// Broadcast routes
		self.routes = [
			{
				path: 'postTransactions',
				collection: 'transactions',
				object: 'transaction',
			},
			{
				path: 'postSignatures',
				collection: 'signatures',
				object: 'signature',
			},
		];

		jobsQueue.register(
			'broadcasterNextRelease',
			nextRelease,
			self.config.broadcastInterval
		);
	}

	/**
	 * Adds new object {params, options} to queue array.
	 *
	 * @param {Object} params
	 * @param {Object} options
	 * @returns {Object[]} Queue private variable with new data
	 * @todo Add description for the params
	 */
	enqueue(params, options) {
		try {
			options.immediate = false;
			return this.queue.push({ params, options });
		} catch (err) {
			throw new Error('Broadcaster:enqueue', err);
		}
	}

	/**
	 * Calls peers.list function to get peers.
	 *
	 * @param {Object} params
	 * @param {function} cb
	 * @returns {SetImmediate} error, peers
	 * @todo Add description for the params
	 */
	getPeers(params, cb) {
		params.limit = params.limit || this.config.peerLimit;
		params.broadhash = params.broadhash || null;
		params.normalized = false;

		const originalLimit = params.limit;
		modules.peers.list(params, (err, peers) => {
			if (err) {
				return setImmediate(cb, err);
			}

			if (originalLimit === constants.maxPeers) {
				library.logger.info(
					[
						'Broadhash consensus now',
						modules.peers.getLastConsensus(),
						'%',
					].join(' ')
				);
			}

			return setImmediate(cb, null, peers);
		});
	}

	/**
	 * Gets peers and for each peer create it and broadcast.
	 *
	 * @param {Object} params
	 * @param {Object} options
	 * @param {function} cb
	 * @returns {SetImmediate} error, peers
	 * @todo Add description for the params
	 */
	broadcast(params, options, cb) {
		options.data.peer = library.logic.peers.me();
		params.limit = params.limit || this.config.peerLimit;
		params.broadhash = params.broadhash || null;

		async.waterfall(
			[
				function getPeers(waterCb) {
					if (!params.peers) {
						return self.getPeers(params, waterCb);
					}
					return setImmediate(waterCb, null, params.peers);
				},
				function sendToPeer(peers, waterCb) {
					library.logger.info('Begin broadcast', options);

					if (options.data.block) {
						try {
							options.data.block = bson.serialize(options.data.block);
						} catch (err) {
							library.logger.error('Broadcast serialization failed:', err);
							return setImmediate(cb, err);
						}
					}

					if (params.limit === self.config.peerLimit) {
						peers = peers.slice(0, self.config.broadcastLimit);
					}
					async.eachLimit(
						peers,
						self.config.parallelLimit,
						(peer, eachLimitCb) => {
							peer.rpc[options.api](options.data, err => {
								if (err) {
									library.logger.error(
										`Failed to broadcast to peer: ${peer.string}`,
										err
									);
								}
								return setImmediate(eachLimitCb);
							});
						},
						err => {
							library.logger.info('End broadcast');
							return setImmediate(waterCb, err, peers);
						}
					);
				},
			],
			(err, peers) => {
				if (cb) {
					return setImmediate(cb, err, { body: null, peer: peers });
				}
			}
		);
	}
}

// Public methods
/**
 * Counts relays and valid limit.
 *
 * @param {Object} object
 * @returns {boolean} true - If broadcast relays exhausted
 * @todo Add description for the params
 */
Broadcaster.prototype.maxRelays = function(object) {
	if (!Number.isInteger(object.relays)) {
		object.relays = 0; // First broadcast
	}

	if (Math.abs(object.relays) >= self.config.relayLimit) {
		library.logger.info('Broadcast relays exhausted', object);
		return true;
	}
	object.relays++; // Next broadcast
	return false;
};

/**
 * Binds input parameters to private variables modules.
 *
 * @param {Peers} peers
 * @param {Transport} transport
 * @param {Transactions} transactions
 * @todo Add description for the params
 */
Broadcaster.prototype.bind = function(peers, transport, transactions) {
	modules = {
		peers,
		transport,
		transactions,
	};
};

// Broadcaster timer
function nextRelease(cb) {
	__private.releaseQueue(err => {
		if (err) {
			library.logger.info('Broadcaster timer', err);
		}
		return setImmediate(cb);
	});
}

// Private
/**
 * Filters private queue based on broadcasts.
 *
 * @private
 * @param {function} cb
 * @returns {SetImmediate} null, boolean|undefined
 * @todo Add description for the params
 */
__private.filterQueue = function(cb) {
	library.logger.info(`Broadcasts before filtering: ${self.queue.length}`);

	async.filter(
		self.queue,
		(broadcast, filterCb) => {
			if (broadcast.options.immediate) {
				return setImmediate(filterCb, null, false);
			} else if (broadcast.options.data) {
				const transaction =
					broadcast.options.data.transaction ||
					broadcast.options.data.signature;
				return __private.filterTransaction(transaction, filterCb);
			}
			return setImmediate(filterCb, null, true);
		},
		(err, broadcasts) => {
			self.queue = broadcasts;

			library.logger.info(`Broadcasts after filtering: ${self.queue.length}`);
			return setImmediate(cb);
		}
	);
};

/**
 * Checks if transaction is in pool or confirm it.
 *
 * @private
 * @param {transaction} transaction
 * @param {function} cb
 * @returns {SetImmediate} null, boolean
 * @todo Add description for the params
 */
__private.filterTransaction = function(transaction, cb) {
	if (transaction !== undefined) {
		if (modules.transactions.transactionInPool(transaction.id)) {
			return setImmediate(cb, null, true);
		}
		return library.logic.transaction.checkConfirmed(transaction, err =>
			setImmediate(cb, null, !err)
		);
	}
	return setImmediate(cb, null, false);
};

/**
 * Groups broadcasts by api.
 *
 * @private
 * @param {Object} broadcasts
 * @returns {Object[]} Squashed routes
 * @todo Add description for the params
 */
__private.squashQueue = function(broadcasts) {
	const grouped = _.groupBy(broadcasts, broadcast => broadcast.options.api);
	const squashed = [];

	self.routes.forEach(route => {
		if (Array.isArray(grouped[route.path])) {
			const data = {};

			data[route.collection] = grouped[route.path]
				.map(broadcast => broadcast.options.data[route.object])
				.filter(Boolean);

			squashed.push({
				options: { api: route.path, data },
				immediate: false,
			});
		}
	});

	return squashed;
};

/**
 * Releases enqueued broadcasts:
 * - filterQueue
 * - squashQueue
 * - broadcast
 *
 * @private
 * @param {function} cb
 * @returns {SetImmediate}
 * @todo Add description for the params
 */
__private.releaseQueue = function(cb) {
	library.logger.info('Releasing enqueued broadcasts');

	if (!self.queue.length) {
		library.logger.info('Queue empty');
		return setImmediate(cb);
	}

	async.waterfall(
		[
			function filterQueue(waterCb) {
				return __private.filterQueue(waterCb);
			},
			function squashQueue(waterCb) {
				const broadcasts = self.queue.splice(0, self.config.releaseLimit);
				return setImmediate(waterCb, null, __private.squashQueue(broadcasts));
			},
			function getPeers(broadcasts, waterCb) {
				self.getPeers({}, (err, peers) =>
					setImmediate(waterCb, err, broadcasts, peers)
				);
			},
			function broadcast(broadcasts, peers, waterCb) {
				async.eachSeries(
					broadcasts,
					(broadcast, eachSeriesCb) => {
						self.broadcast(
							extend({ peers }, broadcast.params),
							broadcast.options,
							eachSeriesCb
						);
					},
					err => setImmediate(waterCb, err, broadcasts)
				);
			},
		],
		(err, broadcasts) => {
			if (err) {
				library.logger.error('Failed to release broadcast queue', err);
			} else {
				library.logger.info(`Broadcasts released: ${broadcasts.length}`);
			}
			return setImmediate(cb);
		}
	);
};

// Export
module.exports = Broadcaster;
