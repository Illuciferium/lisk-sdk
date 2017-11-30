'use strict';

var test = require('../../../functional.js');

var lisk = require('lisk-js');
var expect = require('chai').expect;

var shared = require('../../../shared');
var localShared = require('./shared');
var accountFixtures = require('../../../../fixtures/accounts');

var apiHelpers = require('../../../../common/apiHelpers');
var randomUtil = require('../../../../common/utils/random');

describe('POST /api/transactions (validate type 2 on top of type 1)', function () {

	var transaction;
	var badTransactions = [];
	var goodTransactions = [];

	var account = randomUtil.account();

	localShared.beforeValidationPhase(account);

	describe('registering delegate', function () {

		it('using no second passphrase on an account with second passphrase enabled should fail', function () {
			transaction = lisk.delegate.createDelegate(account.password, account.username);

			return apiHelpers.sendTransactionPromise(transaction).then(function (res) {
				expect(res).to.have.property('status').to.equal(400);
				expect(res).to.have.nested.property('body.message').to.equal('Missing sender second signature');
				badTransactions.push(transaction);
			});
		});

		it('using second passphrase not matching registered secondPublicKey should fail', function () {
			transaction = lisk.delegate.createDelegate(account.password, account.username, 'invalid password');

			return apiHelpers.sendTransactionPromise(transaction).then(function (res) {
				expect(res).to.have.property('status').to.equal(400);
				expect(res).to.have.nested.property('body.message').to.equal('Failed to verify second signature');
				badTransactions.push(transaction);
			});
		});

		it('using correct second passphrase should be ok', function () {
			transaction = lisk.delegate.createDelegate(account.password, account.username, account.secondPassword);

			return apiHelpers.sendTransactionPromise(transaction).then(function (res) {
				expect(res).to.have.property('status').to.equal(200);
				expect(res).to.have.nested.property('body.status').to.equal('Transaction(s) accepted');
				goodTransactions.push(transaction);
			});
		});
	});

	describe('confirmation', function () {

		shared.confirmationPhase(goodTransactions, badTransactions);
	});
});
