// Load the electrum library.
const ElectrumClient = require('../electrum.js').Client;

// Wrap the application in an async function to allow use of await/async.
const main = async function()
{
	// Initialize an electrum client.
	const electrum = new ElectrumClient('Electrum client example', '1.4.1', 'bch.imaginary.cash');

	// Wait for the client to connect
	await electrum.connect();

	// Declare an example transaction ID.
	const transactionID = '4db095f34d632a4daf942142c291f1f2abb5ba2e1ccac919d85bdc2f671fb251';

	// Request the full transaction hex for the transaction ID.
	const transactionHex = await electrum.request('blockchain.transaction.get', transactionID);

	// Print out the transaction hex.
	console.log(transactionHex);

	// Subscribe to block header notifications.
	await electrum.subscribe(console.log, 'blockchain.headers.subscribe');

	// Disconncet from the server.
	electrum.disconnect();
};

// Run the application.
main();
