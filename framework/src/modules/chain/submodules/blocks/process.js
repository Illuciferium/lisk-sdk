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

const _ = require('lodash');
const async = require('async');
const { Status: TransactionStatus } = require('@liskhq/lisk-transactions');
const { promisify } = require('util');
const { convertErrorsToString } = require('../../helpers/error_handlers');
const slots = require('../../helpers/slots');
const definitions = require('../../schema/definitions');
const blockVersion = require('../../logic/block_version');

const { MAX_TRANSACTIONS_PER_BLOCK, ACTIVE_DELEGATES } = global.constants;

const __private = {};
let modules;
let library;
let self;
let deleteLastBlock;

/**
 * Main process logic. Allows process blocks. Initializes library.
 *
 * @class
 * @memberof modules.blocks
 * @see Parent: {@link modules.blocks}
 * @requires async
 * @requires lodash
 * @requires helpers/slots
 * @requires logic/peer
 * @param {Object} logger
 * @param {Block} block
 * @param {Peers} peers
 * @param {ZSchema} schema
 * @param {Storage} storage
 * @param {Sequence} sequence
 * @param {Object} genesisBlock
 * @todo Add description for the params
 */
class Process {
	constructor(
		logger,
		block,
		peers,
		schema,
		storage,
		sequence,
		genesisBlock,
		channel,
		initTransaction
	) {
		library = {
			channel,
			logger,
			schema,
			storage,
			sequence,
			genesisBlock,
			logic: {
				block,
				peers,
				initTransaction,
			},
		};
		self = this;

		library.logger.trace('Blocks->Process: Submodule initialized.');
		return self;
	}

	/**
	 * Loads full blocks from database, used when rebuilding blockchain, snapshotting,
	 * see: loader.loadBlockChain (private).
	 *
	 * @param {number} blocksAmount - Amount of blocks
	 * @param {number} fromHeight - Height to start at
	 * @param {function} cb - Callback function
	 * @returns {function} cb - Callback function from params (through setImmediate)
	 * @returns {Object} cb.err - Error if occurred
	 * @returns {Object} cb.lastBlock - Current last block
	 */
	// eslint-disable-next-line class-methods-use-this
	loadBlocksOffset(blocksAmount, fromHeight = 0, cb) {
		// Calculate toHeight
		const toHeight = fromHeight + blocksAmount;

		library.logger.debug('Loading blocks offset', {
			limit: toHeight,
			offset: fromHeight,
		});

		const filters = {
			height_gte: fromHeight,
			height_lt: toHeight,
		};

		const options = {
			limit: null,
			sort: ['height:asc', 'rowId:asc'],
			extended: true,
		};

		// Loads extended blocks from storage
		library.storage.entities.Block.get(filters, options)
			.then(rows => {
				// Normalize blocks
				const blocks = modules.blocks.utils.readStorageRows(rows);

				async.eachSeries(
					blocks,
					(block, eachBlockSeriesCb) => {
						// Stop processing if node shutdown was requested
						if (modules.blocks.isCleaning.get()) {
							return setImmediate(eachBlockSeriesCb);
						}

						library.logger.debug('Processing block', block.id);

						if (block.id === library.genesisBlock.block.id) {
							// Apply block - saveBlock: false
							return modules.blocks.chain.applyGenesisBlock(block, err =>
								setImmediate(eachBlockSeriesCb, err)
							);
						}

						// Process block - broadcast: false, saveBlock: false
						return modules.blocks.verify.processBlock(
							block,
							false,
							false,
							err => {
								if (err) {
									library.logger.debug('Block processing failed', {
										id: block.id,
										err: err.toString(),
										module: 'blocks',
										block,
									});
								}
								return setImmediate(eachBlockSeriesCb, err);
							}
						);
					},
					err => setImmediate(cb, err, modules.blocks.lastBlock.get())
				);
			})
			.catch(err => {
				library.logger.error(err);
				return setImmediate(
					cb,
					new Error(`Blocks#loadBlocksOffset error: ${err}`)
				);
			});
	}

	/**
	 * Ask the network for blocks and process them.
	 *
	 * @param {function} cb - Callback function
	 * @returns {function} cb - Callback function from params (through setImmediate)
	 * @returns {Object} cb.err - Error if occurred
	 * @returns {Object} cb.lastValidBlock - Normalized new last block
	 */
	// eslint-disable-next-line class-methods-use-this
	loadBlocksFromNetwork(cb) {
		let lastValidBlock = modules.blocks.lastBlock.get();

		library.logger.debug('Loading blocks from the network');

		async function getBlocksFromNetwork() {
			// TODO: If there is an error, invoke the applyPenalty action on the Network module once it is implemented.
			// TODO: Rename procedure to include target module name. E.g. chain:blocks
			let data;
			try {
				const response = await library.channel.invoke('network:request', {
					procedure: 'blocks',
					data: {
						lastBlockId: lastValidBlock.id,
					},
				});
				data = response.data;
			} catch (p2pError) {
				library.logger.error('Failed to load block from network', p2pError);
				return [];
			}

			if (!data) {
				throw new Error('Received an invalid blocks response from the network');
			}
			// Check for strict equality for backwards compatibility reasons.
			if (data.success === false) {
				throw new Error(
					`Peer did not have a matching lastBlockId. ${data.message}`
				);
			}

			return data.blocks;
		}

		function validateBlocks(blocks, seriesCb) {
			const report = library.schema.validate(blocks, definitions.WSBlocksList);

			if (!report) {
				return setImmediate(
					seriesCb,
					new Error('Received invalid blocks data')
				);
			}
			return setImmediate(seriesCb, null, blocks);
		}
		// Process all received blocks
		function processBlocks(blocks, seriesCb) {
			// Skip if ther is no blocks
			if (blocks.length === 0) {
				return setImmediate(seriesCb);
			}
			// Iterate over received blocks, normalize block first...
			return async.eachSeries(
				modules.blocks.utils.readDbRows(blocks),
				(block, eachSeriesCb) => {
					if (modules.blocks.isCleaning.get()) {
						// Cancel processing if node shutdown was requested
						return setImmediate(eachSeriesCb);
					}
					// ...then process block
					// TODO: If there is an error, invoke the applyPenalty action on the Network module once it is implemented.
					return processBlock(block, err => eachSeriesCb(err));
				},
				err => setImmediate(seriesCb, err)
			);
		}
		// Process single block
		function processBlock(block, seriesCb) {
			// Start block processing - broadcast: false, saveBlock: true
			modules.blocks.verify.processBlock(block, false, true, err => {
				if (!err) {
					// Update last valid block
					lastValidBlock = block;
					library.logger.info(
						`Block ${block.id} loaded from the network`,
						`height: ${block.height}`
					);
				} else {
					const id = block ? block.id : 'null';

					library.logger.debug('Block processing failed', {
						id,
						err: err.toString(),
						module: 'blocks',
						block,
					});
				}
				return seriesCb(err);
			});
		}

		async.waterfall(
			[getBlocksFromNetwork, validateBlocks, processBlocks],
			err => {
				if (err) {
					return setImmediate(
						cb,
						`Error loading blocks: ${err.message || err}`,
						lastValidBlock
					);
				}
				return setImmediate(cb, null, lastValidBlock);
			}
		);
	}

	/**
	 * Generate new block, see: loader.loadBlockChain (private).
	 *
	 * @param {Object} keypair - Pair of private and public keys, see: helpers.ed.makeKeypair
	 * @param {number} timestamp - Slot time, see: helpers.slots.getSlotTime
	 * @param {function} cb - Callback function
	 * @returns {function} cb - Callback function from params (through setImmediate)
	 * @returns {Object} cb.err - Error message if error occurred
	 */
	// eslint-disable-next-line class-methods-use-this
	generateBlock(keypair, timestamp, cb) {
		// Get transactions that will be included in block
		const transactions =
			modules.transactions.getUnconfirmedTransactionList(
				false,
				MAX_TRANSACTIONS_PER_BLOCK
			) || [];

		const context = {
			blockTimestamp: timestamp,
			blockHeight: modules.blocks.lastBlock.get().height + 1,
			blockVersion: blockVersion.currentBlockVersion,
		};

		const allowedTransactionsIds = modules.processTransactions
			.checkAllowedTransactions(transactions, context)
			.transactionsResponses.filter(
				transactionResponse =>
					transactionResponse.status === TransactionStatus.OK
			)
			.map(transactionReponse => transactionReponse.id);

		const allowedTransactions = transactions.filter(transaction =>
			allowedTransactionsIds.includes(transaction.id)
		);

		modules.processTransactions
			.verifyTransactions(allowedTransactions)
			.then(({ transactionsResponses: responses }) => {
				const readyTransactions = transactions.filter(transaction =>
					responses
						.filter(response => response.status === TransactionStatus.OK)
						.map(response => response.id)
						.includes(transaction.id)
				);

				// Create a block
				const lastBlock = modules.blocks.lastBlock.get();
				const block = library.logic.block.create({
					keypair,
					timestamp,
					previousBlock: lastBlock,
					transactions: readyTransactions,
					heightPrevoted: 1,
					heightPrevious: 1,
					height: lastBlock.height + 1,
				});

				// Start block processing - broadcast: true, saveBlock: true
				return modules.blocks.verify.processBlock(block, true, true, cb);
			})
			.catch(e => {
				library.logger.error(e.stack);
				return setImmediate(cb, e);
			});
	}

	/**
	 * Handle newly received block.
	 *
	 * @listens module:transport~event:receiveBlock
	 * @param {block} block - New block
	 * @todo Add @returns tag
	 */
	// eslint-disable-next-line class-methods-use-this
	onReceiveBlock(block) {
		// When client is not loaded, is syncing
		// Do not receive new blocks as client is not ready
		if (!__private.loaded) {
			return library.logger.debug(
				'Client is not ready to receive block',
				block.id
			);
		}

		if (modules.loader.syncing()) {
			return library.logger.debug(
				"Client is syncing. Can't receive block at the moment.",
				block.id
			);
		}

		// New block version, different onReceiveBlock implementation
		if (block.version === 1) {
			// TODO: Remove hard coding.
			return this.forkChoice(block);
		}

		// Execute in sequence via sequence. TODO: Remove after compatibility window is over.
		return library.sequence.add(cb => {
			// Get the last block
			const lastBlock = modules.blocks.lastBlock.get();

			// Detect sane block
			if (
				block.previousBlock === lastBlock.id &&
				lastBlock.height + 1 === block.height
			) {
				// Process received block
				return __private.receiveBlock(block, cb);
			}

			if (
				block.previousBlock !== lastBlock.id &&
				lastBlock.height + 1 === block.height
			) {
				// Process received fork cause 1
				return __private.receiveForkOne(block, lastBlock, cb);
			}

			if (
				block.previousBlock === lastBlock.previousBlock &&
				block.height === lastBlock.height &&
				block.id !== lastBlock.id
			) {
				// Process received fork cause 5
				return __private.receiveForkFive(block, lastBlock, cb);
			}

			if (block.id === lastBlock.id) {
				library.logger.debug('Block already processed', block.id);
			} else {
				library.logger.warn(
					`Discarded block that does not match with current chain: ${
						block.id
					} height: ${block.height} round: ${slots.calcRound(
						block.height
					)} slot: ${slots.getSlotNumber(block.timestamp)} generator: ${
						block.generatorPublicKey
					}`
				);
			}

			// Discard received block
			return setImmediate(cb);
		});
	}

	/**
	 * Handle newly received block.
	 *
	 * @listens module:transport~event:receiveBlock
	 * @param {block} block - New block
	 */
	// eslint-disable-next-line class-methods-use-this
	forkChoice(block) {
		// Current slot number based on current time since LiskEpoch ~ Slot number at the time the new block is received
		// Better to do it here rather than in the Sequence so reciving time is more accurate
		const newBlockReceivedAtSlot = slots.getSlotNumber();

		// Execute in sequence via sequence
		return library.sequence.add(callback => {
			this._forkChoiceTask(block, newBlockReceivedAtSlot)
				.then(result => callback(null, result))
				.catch(error => callback(error));
		});
	}

	/**
	 * Handle modules initialization
	 * - accounts
	 * - blocks
	 * - delegates
	 * - loader
	 * - rounds
	 * - transactions
	 * - transport
	 *
	 * @param {modules} scope - Exposed modules
	 */
	// eslint-disable-next-line class-methods-use-this
	onBind(scope) {
		library.logger.trace('Blocks->Process: Shared modules bind.');
		modules = {
			accounts: scope.modules.accounts,
			blocks: scope.modules.blocks,
			delegates: scope.modules.delegates,
			loader: scope.modules.loader,
			peers: scope.modules.peers,
			rounds: scope.modules.rounds,
			transactions: scope.modules.transactions,
			transport: scope.modules.transport,
			processTransactions: scope.modules.processTransactions,
		};

		deleteLastBlock = promisify(modules.blocks.chain.deleteLastBlock);

		// Set module as loaded
		__private.loaded = true;
	}

	/**
	 * Wrap of fork choice rule logic so it can be added to Sequence and properly tested
	 * @param block
	 * @param newBlockReceivedAtSlot - Slot number when the block was received
	 * @return {Promise}
	 * @private
	 */
	async _forkChoiceTask(block, newBlockReceivedAtSlot) {
		const lastBlock = modules.blocks.lastBlock.get();

		const forgingSlotLastBlock = slots.getSlotNumber(lastBlock.timestamp);
		const forgingSlotNewBlock = slots.getSlotNumber(block.timestamp);

		// Slot number when lastBlock was received.
		const lastBlockReceivedAtSlot = !modules.blocks.lastReceipt.get()
			? forgingSlotLastBlock
			: slots.getTime(modules.blocks.lastReceipt.get() * 1000);

		if (lastBlock.id === block.id) {
			// Case 1: same block received twice
			return this._handleSameBlockReceived(block);
		}

		if (
			lastBlock.height + 1 === block.height &&
			block.previousBlock === lastBlock.id
		) {
			// Case 2: correct block received
			return this._handleGoodBlock(block);
		}

		if (
			lastBlock.height === block.height &&
			lastBlock.heightPrevoted === block.heightPrevoted &&
			lastBlock.previousBlock === block.previousBlock
		) {
			// Delegates are the same
			if (lastBlock.generatorPublicKey === block.generatorPublicKey) {
				// Case 3: double forging different blocks in the same slot.
				// Last Block stands.
				return this._handleDoubleForging(block);
			}

			// Two competing blocks by different delegates at the same height.
			if (
				forgingSlotLastBlock < forgingSlotNewBlock &&
				!this._receivedInSlot(lastBlock, lastBlockReceivedAtSlot) &&
				this._receivedInSlot(block, newBlockReceivedAtSlot)
			) {
				// Case 4: Tie break
				return this._handleDoubleForgingTieBreak(block, lastBlock);
			}
		}

		// Case 5: received block has priority. Move to a different chain.
		if (
			lastBlock.heightPrevoted < block.heightPrevoted ||
			(lastBlock.height < block.height &&
				lastBlock.heightPrevoted === block.heightPrevoted)
		) {
			return this._handleMovingToDifferentChain();
			// TODO: Move to a different chain
		}

		// Discard newly received block
		return library.logger.warn(
			`Discarded block that does not match with current chain: ${
				block.id
			} height: ${block.height} round: ${slots.calcRound(
				block.height
			)} slot: ${slots.getSlotNumber(block.timestamp)} generator: ${
				block.generatorPublicKey
			}`
		);
	}

	/**
	 * Block IDs are the same ~ Blocks are equal
	 * @param block
	 * @returns {*}
	 * @private
	 */
	// eslint-disable-next-line class-methods-use-this
	_handleSameBlockReceived(block) {
		library.logger.debug('Block already processed', block.id);
	}

	/**
	 * Block received is correct
	 * @param block
	 * @returns {Promise}
	 * @private
	 */
	_handleGoodBlock(block) {
		return this._processBlock(block);
	}

	/**
	 * Double forging. Last block stands
	 * @param block
	 * @returns {*}
	 * @private
	 */
	// eslint-disable-next-line class-methods-use-this
	_handleDoubleForging(block) {
		library.logger.warn(
			'Delegate forging on multiple nodes',
			block.generatorPublicKey
		);
		library.logger.info('Last block stands');
		// TODO: Implement Proof of Misbehavior
	}

	/**
	 * Tie break: two competing blocks by different delegates at the same height.
	 * @param lastBlock
	 * @param newBlock
	 * @returns {Promise}
	 * @private
	 */
	async _handleDoubleForgingTieBreak(newBlock, lastBlock) {
		try {
			// Normalize and check schema
			const normalizedNewBlock = library.logic.block.objectNormalize(
				_.cloneDeep(newBlock)
			);

			// Validate block has been generated by correct delegate
			await this._validateGenerator(normalizedNewBlock, lastBlock);

			// Verify block data, signatures, etc
			// TODO: Maybe `verifyReceipt` could throw errors instead of returning checks.
			const check = modules.blocks.verify.verifyReceipt(normalizedNewBlock);

			if (!check.verified) {
				library.logger.error(
					`Block ${normalizedNewBlock.id} verification failed`,
					check.errors.join(', ')
				);
				// Return first error from checks
				throw check.errors[0];
			}
		} catch (error) {
			// Should there be any errors while validating and verifying,
			// last block is kept as the tip of the chain
			library.logger.error(
				'Case 4 fork recovery failed',
				convertErrorsToString(error)
			);
			throw error;
		}

		// If the new block is correctly validated and verified,
		// last bloc kis deleted and new block is added to the tip chain
		library.logger.info('Deleting last block due to case 4');
		await deleteLastBlock();

		return this._processBlock(newBlock);
	}

	/**
	 * Move to a different chain
	 * @private
	 */
	// eslint-disable-next-line class-methods-use-this
	_handleMovingToDifferentChain() {
		// TODO: Move to a different chain.
	}

	/**
	 * Update last receipt and process newly received block.
	 * @param block
	 * @private
	 */
	// eslint-disable-next-line class-methods-use-this
	_processBlock(block) {
		return promisify(__private.receiveBlock)(block); // TODO: Convert __private.receiveBlock to async, move implementation here to async and remove from __private.
	}

	/**
	 * Checks whether a block is forged by the designated delegate of the slot
	 * based on a deterministic delegate list
	 * Wrapper over __private.validateBlockSlot <- Will be removed
	 * @param block
	 * @param lastBlock
	 * @return {never}
	 * @private
	 */
	// eslint-disable-next-line class-methods-use-this
	_validateGenerator(block, lastBlock) {
		return promisify(__private.validateBlockSlot)(block, lastBlock); // TODO: Convert __private.validateBlockSlot to async and remove from __private.
	}

	/**
	 * Check if block is received in the designated time window of the block slot.
	 * @param block
	 * @param receivedAt - Time when the block was received since Lisk's Epoch time
	 * @return {boolean}
	 * @private
	 */
	// eslint-disable-next-line class-methods-use-this
	_receivedInSlot(block, receivedAt) {
		return slots.timeFallsInSlot(
			slots.getSlotNumber(block.timestamp),
			receivedAt
		);
	}
}

// TODO: Remove all this functions after compatibility window is over.

/**
 * Receive block - logs info about received block, updates last receipt, processes block.
 *
 * @private
 * @func receiveBlock
 * @param {Object} block - Full normalized block
 * @param {function} cb - Callback function
 */
__private.receiveBlock = function(block, cb) {
	library.logger.info(
		`Received new block id: ${block.id} height: ${
			block.height
		} round: ${slots.calcRound(block.height)} slot: ${slots.getSlotNumber(
			block.timestamp
		)} reward: ${block.reward}`
	);

	// Update last receipt
	modules.blocks.lastReceipt.update(); // TODO: Probably not needed anymore.
	// Start block processing - broadcast: true, saveBlock: true
	modules.blocks.verify.processBlock(block, true, true, cb);
};

/**
 * Receive block detected as fork cause 1: Consecutive height but different previous block id.
 *
 * @private
 * @func receiveBlock
 * @param {Object} block - Received block
 * @param {function} cb - Callback function
 */
__private.receiveForkOne = function(block, lastBlock, cb) {
	let tmpBlock = _.clone(block);

	// Fork: Consecutive height but different previous block id
	modules.delegates.fork(block, 1);

	// Keep the oldest block, or if both have same age, keep block with lower id
	if (
		block.timestamp > lastBlock.timestamp ||
		(block.timestamp === lastBlock.timestamp && block.id > lastBlock.id)
	) {
		library.logger.info('Last block stands');
		return setImmediate(cb); // Discard received block
	}
	return async.series(
		[
			function(seriesCb) {
				try {
					tmpBlock = library.logic.block.objectNormalize(tmpBlock);
				} catch (err) {
					return setImmediate(seriesCb, err);
				}
				return setImmediate(seriesCb);
			},
			// Check valid slot
			function(seriesCb) {
				__private.validateBlockSlot(tmpBlock, lastBlock, seriesCb);
			},
			// Check received block before any deletion
			function(seriesCb) {
				const check = modules.blocks.verify.verifyReceipt(tmpBlock);

				if (!check.verified) {
					library.logger.error(
						`Block ${tmpBlock.id} verification failed`,
						check.errors.join(', ')
					);
					// Return first error from checks
					return setImmediate(seriesCb, check.errors[0]);
				}
				library.logger.info('Last block and parent loses due to fork 1');
				return setImmediate(seriesCb);
			},
			// Delete last 2 blocks
			modules.blocks.chain.deleteLastBlock,
			modules.blocks.chain.deleteLastBlock,
		],
		err => {
			if (err) {
				library.logger.error(
					'Fork recovery failed',
					convertErrorsToString(err)
				);
			}
			return setImmediate(cb, err);
		}
	);
};

/**
 * Receive block detected as fork cause 5: Same height and previous block id, but different block id.
 *
 * @private
 * @method receiveBlock
 * @param {Object} block - Received block
 * @param {function} cb - Callback function
 */
__private.receiveForkFive = function(block, lastBlock, cb) {
	let tmpBlock = _.clone(block);
	// Fork: Same height and previous block id, but different block id
	modules.delegates.fork(block, 5);

	// Check if delegate forged on more than one node
	if (block.generatorPublicKey === lastBlock.generatorPublicKey) {
		library.logger.warn(
			'Delegate forging on multiple nodes',
			block.generatorPublicKey
		);
	}

	// Keep the oldest block, or if both have same age, keep block with lower id
	if (
		block.timestamp > lastBlock.timestamp ||
		(block.timestamp === lastBlock.timestamp && block.id > lastBlock.id)
	) {
		library.logger.info('Last block stands');
		return setImmediate(cb); // Discard received block
	}
	return async.series(
		[
			function(seriesCb) {
				try {
					tmpBlock = library.logic.block.objectNormalize(tmpBlock);
				} catch (err) {
					return setImmediate(seriesCb, err);
				}
				return setImmediate(seriesCb);
			},
			// Check valid slot
			function(seriesCb) {
				__private.validateBlockSlot(tmpBlock, lastBlock, seriesCb);
			},
			// Check received block before any deletion
			function(seriesCb) {
				const check = modules.blocks.verify.verifyReceipt(tmpBlock);

				if (!check.verified) {
					library.logger.error(
						`Block ${tmpBlock.id} verification failed`,
						check.errors.join(', ')
					);
					// Return first error from checks
					return setImmediate(seriesCb, check.errors[0]);
				}
				return setImmediate(seriesCb);
			},
			// Delete last block
			function(seriesCb) {
				library.logger.info('Last block loses due to fork 5');
				modules.blocks.chain.deleteLastBlock(seriesCb);
			},
			// Process received block
			function(seriesCb) {
				return __private.receiveBlock(block, seriesCb);
			},
		],
		err => {
			if (err) {
				library.logger.error(
					'Fork recovery failed',
					convertErrorsToString(err)
				);
			}
			return setImmediate(cb, err);
		}
	);
};

/**
 * Validate if block generator is valid delegate.
 *
 * @private
 * @func validateBlockSlot
 * @param {Object} block - Current normalized block
 * @param {Object} lastBlock - Last normalized block
 * @param {Function} cb - Callback function
 */
__private.validateBlockSlot = function(block, lastBlock, cb) {
	const roundNextBlock = slots.calcRound(block.height);
	const roundLastBlock = slots.calcRound(lastBlock.height);

	if (
		lastBlock.height % ACTIVE_DELEGATES === 0 ||
		roundLastBlock < roundNextBlock
	) {
		// Check if block was generated by the right active delagate from previous round.
		// DATABASE: Read only to mem_accounts to extract active delegate list
		modules.delegates.validateBlockSlotAgainstPreviousRound(block, err =>
			setImmediate(cb, err)
		);
	} else {
		// Check if block was generated by the right active delagate.
		// DATABASE: Read only to mem_accounts to extract active delegate list
		modules.delegates.validateBlockSlot(block, err => setImmediate(cb, err));
	}
};

module.exports = Process;
