// Load the testing framework.
const test = require('ava');
// const sinon = require('sinon');

// Load the electrum library.
const ElectrumClient = require('../electrum.js').Client;
const ElectrumCluster = require('../electrum.js').Cluster;

// Declare available usecases.
const usecases =
{
	// Fetch transaction
	getTransaction: require('./usecases/getTransaction.js'),
};

// Declare usecase as a global-scope reference variable.
let usecase;

// Set up contract creation test.
const testClientRequest = async function(test)
{
	// Initialize an electrum client.
	const electrum = new ElectrumClient('Electrum client test', '1.4.1', 'bch.imaginary.cash');

	// Wait for the client to connect
	await electrum.connect();

	// Perform the request according to the usecase.
	const requestOutput = await electrum.request(...usecase.request.input);

	// Close the connection.
	await electrum.disconnect();

	// Verify that the transaction hex matches expectations.
	test.true(requestOutput === usecase.request.output);
};

// Set up contract creation test.
const testClusterRequest = async function(test)
{
	// Initialize an electrum cluster where 2 out of 3 needs to be consistent, polled randomly with fail-over.
	const electrum = new ElectrumCluster('Electrum cluster example', '1.4.1', 2, 3, ElectrumCluster.ORDER.RANDOM);

	// Add some servers to the cluster.
	electrum.addServer('bch.imaginary.cash');
	electrum.addServer('electroncash.de');
	electrum.addServer('electroncash.dk');
	electrum.addServer('electron.jochen-hoenicke.de', 51002);
	electrum.addServer('electrum.imaginary.cash');

	// Wait for enough connections to be available.
	await electrum.ready();

	// Perform the request according to the usecase.
	const requestOutput = await electrum.request(...usecase.request.input);

	// Close all connections.
	await electrum.shutdown();

	// Verify that the transaction hex matches expectations.
	test.true(requestOutput === usecase.request.output);
};

// Set up normal tests.
const runNormalTests = async function()
{
	// For each usecase to test..
	for(let currentUsecase in usecases)
	{
		// .. assign it to the usecase global reference.
		usecase = usecases[currentUsecase];

		// Test top-level non-stubbed library functions in parallell with the current usecase.
		test.serial('Request data from client', testClientRequest);
		test.serial('Request data from cluster', testClusterRequest);

		// Test top-level stubbed library functions in series with the current usecase.
		// NOTE: We do not have any stubbed tests yet.
	}
};

/*
// Define invalid test cases.
const runFailureTests = async function()
{
	// Process the verification of the example message and an empty signature.
	//let signatureStatus = await oracle.verifyMessage(example.message, null);

	// Verify that the signature verification results in false.
	//test.false(signatureStatus, 'Message verification should fail when the signature is empty.');

};
*/

const runTests = async function()
{
	// Run normal and failure tests.
	await runNormalTests();
	// await runFailureTests();
};

// Run all tests.
runTests();

