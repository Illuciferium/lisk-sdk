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

module.exports = async ({ ed, schema, components: { storage, logger } }) => {
	const Block = require('../logic/block.js');
	const Account = require('../logic/account.js');

	const accountLogic = await new Promise((resolve, reject) => {
		new Account(storage, schema, logger, (err, object) => {
			err ? reject(err) : resolve(object);
		});
	});

	const blockLogic = await new Promise((resolve, reject) => {
		new Block(ed, schema, (err, object) => {
			err ? reject(err) : resolve(object);
		});
	});

	return {
		account: accountLogic,
		block: blockLogic,
	};
};
