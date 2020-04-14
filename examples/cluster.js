// Load the electrum library.
const ElectrumCluster = require('../electrum.js').Cluster;

// Wrap the application in an async function to allow use of await/async.
const main = async function()
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

	// Declare an example transaction ID.
	const transactionID = '4db095f34d632a4daf942142c291f1f2abb5ba2e1ccac919d85bdc2f671fb251';

	// Request the full transaction hex for the transaction ID.
	const transactionHex = await electrum.request('blockchain.transaction.get', transactionID);

	// Print out the transaction hex.
	console.log(transactionHex);

	// Subscribe to block header notifications.
	await electrum.subscribe(console.log, 'blockchain.headers.subscribe');

	// Close all connections.
	electrum.shutdown();
};

// Run the application.
main();
