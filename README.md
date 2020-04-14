# electrum-cash

Electrum-cash is a lightweight `JavaScript` library that lets you connect with one or more `Electrum` servers. 
It offers encrypted connections by default, 
performs the expected protocol version negotiation and
automatically keeps your connection alive until your close it.

## Installation

Install the library with NPM:

```bash
# npm install electrum-cash
```

## Usage

### Load library

Before you can use the library you need to include it in your project.

If you only want to use a **single serve**r, load the `Client` module:

```js
// Load the electrum library.
const ElectrumClient = require('electrum-cash').Client;
```

If you want to use **multiple servers**, load the `Cluster` module:

```js
// Load the electrum library.
const ElectrumCluster = require('electrum-cash').Cluster;
```

### Connect to servers

After you have loaded the appropiate module you need to initialize the module by configuring your **application identifier** and **protocol version**.

If you only want to use a single server, initialize a `Client` and connect to the server:
```js
// Initialize an electrum client.
const electrum = new ElectrumClient('Electrum client example', '1.4.1', 'bch.imaginary.cash');

// Wait for the client to connect
await electrum.connect();
```

If you want to use multiple servers, initialize a `Cluster` and add some servers:

*For more information on various cluster configurations, read the [cluster documentation](cluster.md).* 

```js
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
```

### Request information

Once your `Client` or `Cluster` is connected and ready, you can call methods:

*For a list of methods you can use, refer to the [Electrum Cash documentation](https://bitcoincash.network/electrum/).*

```js
// Declare an example transaction ID.
const transactionID = '4db095f34d632a4daf942142c291f1f2abb5ba2e1ccac919d85bdc2f671fb251';

// Request the full transaction hex for the transaction ID.
const transactionHex = await electrum.request('blockchain.transaction.get', transactionID);

// Print out the transaction hex.
console.log(transactionHex);
```

### Subscribe to notifications.

Once your `Client` or `Cluster` is connected and ready, you can set up subscriptions to get notifications on events:

*For a list of methods you can subscribe to, refer to the [Electrum Cash documentation](https://bitcoincash.network/electrum/).*

```js
// Set up a callback function to handle new blocks.
const handleNewBlocks = function(data)
{
    // Print out the block information.
    console.log(data);
}

// Set up a subscription for new block headers and handle events with our callback function.
await electrum.subscribe(handleNewBlocks, 'blockchain.headers.subscribe');
```

### Shutting down

When you're done and don't want to be connected anymore you can disconnect the server(s).

If you're using a single `Client`, call the `disconnect()` function:

```js
// Close the connection.
await electrum.disconnect();
```

If you're using a `Cluster` with multiple servers, call the `shutdown()` function.

```js
// Close all connections.
await electrum.shutdown();
```

## Documentation

For a complete list of methods and parameters, read the [API documentation](https://generalprotocols.gitlab.io/electrum-cash/).

## Notes

The keep-alive functionality of this library only works when the protocol version is 1.2 or higher.
