// Load the network libraries.
const tls = require('tls');

// Load the EventEmitter library.
const EventEmitter = require('events').EventEmitter;

// Initialize support for debug message management.
const debug =
{
	action:	require('debug')('electrum:action'),
	events:	require('debug')('electrum:events'),
	errors:	require('debug')('electrum:errors'),
	server:	require('debug')('electrum:server'),
	status:	require('debug')('electrum:status'),
};

/**
 * Grouping of utilities that simplifies implementation of the Electrum protocol.
 */
class ElectrumProtocol
{
	/**
	 * Helper function that builds an Electrum request object.
	 *
	 * @param method       method to call.
	 * @param parameters   method parameters for the call.
	 * @param requestId    unique string or number referencing this request.
	 *
	 * @returns a properly formatted Electrum request object.
	 */
	static buildRequestObject(method, parameters, requestId)
	{
		// Return the formatted request object.
		// NOTE: Electrum either uses JsonRPC strictly or loosely.
		//       If we specify protocol identifier without being 100% compliant, we risk being disconnected/blacklisted.
		//       For this reason, we omit the protocol identifier to avoid issues.
		return JSON.stringify({ method: method, params: parameters, id: requestId });
	}

	/**
	 * Constant used to verify if a provided string is a valid version number.
	 *
	 * @returns a regular expression that matches valid version numbers.
	 */
	static get versionRegexp()
	{
		return /^\d+(\.\d+)+$/;
	}

	/**
	 * Constant used to separate statements/messages in a stream of data.
	 *
	 * @returns the delimiter used by Electrum to separate statements.
	 */
	static get statementDelimiter()
	{
		return '\n';
	}
}

/**
 * Wrapper around TLS sockets that gracefully separates a network stream into Electrum protocol messages.
 */
class ElectrumConnection
{
	/**
	 * Sets up network configuration for an Electrum client connection.
	 *
	 * @param application   your application name, used to identify to the electrum host.
	 * @param version       protocol version to use with the host.
	 * @param host          fully qualified domain name or IP number of the host.
	 * @param port          the TCP network port of the host.
	 * @param keepAlive     send a server ping after this time of inactivity, in seconds.
	 * @param retry         when disconnected, attempt to reconnect after this many seconds.
	 * @param timeout       how long to wait for the initial connection before failing, in seconds.
	 */
	constructor(application, version, host, port = 50002, keepAlive = 300, retry = 900, timeout = 10)
	{
		// Check if the provided version is a valid version number.
		if(!ElectrumProtocol.versionRegexp.test(version))
		{
			// Throw an error since the version number was not valid.
			throw(new Error(`Provided version string (${version}) is not a valid protocol version number.`));
		}

		// Store the version number.
		this.version = version;

		// Store the application name.
		this.application = application;

		// Store the port and hostname.
		this.port = port;
		this.host = host;

		// Store the timeout setting.
		this.timeout = timeout;

		// Store the retry setting.
		this.retry = retry;

		// Initialize an empty keepalive object.
		this.keepAlive =
		{
			limit: keepAlive,
			timestamp: null,
			timer: null,
		};

		// Initialize connection status.
		this.connected = false;

		// Create a new TLS socket.
		this.socket = new tls.TLSSocket();

		// Configure initial connection timeout.
		this.socket.setTimeout(timeout * 1000);

		// Configure encoding.
		this.socket.setEncoding('utf8');

		// Enable persistent connections.
		this.socket.setKeepAlive(true, 0);

		// Disable buffering of outgoing data.
		this.socket.setNoDelay(true);

		// Set up handlers for connection and disconnection.
		this.socket.on('connect', this.onConnect.bind(this));
		this.socket.on('close', this.onDisconnect.bind(this));

		// Set up handler for network errors.
		this.socket.on('error', this.onError.bind(this));

		// Set up timer for handling network timeouts.
		this.socket.on('timeout', this.onTimeout.bind(this));

		// Set up handler for incoming data.
		this.socket.on('data', this.parseMessageChunk.bind(this));

		// Initialize message buffer.
		this.messageBuffer = '';

		// Initialize an empty callback function to parse messages.
		this.messageParser = console.error;
	}

	/**
	 * Assembles incoming data into statements and hands them off to the message parser.
	 *
	 * @param data   data to append to the current message buffer, as a string.
	 */
	parseMessageChunk(data)
	{
		// Add the message to the current message buffer.
		this.messageBuffer += data;

		// Check if the new message buffer contains the statement delimiter.
		while(this.messageBuffer.includes(ElectrumProtocol.statementDelimiter))
		{
			// Split message buffer into statements.
			const statementParts = this.messageBuffer.split(ElectrumProtocol.statementDelimiter);

			// For as long as we still have statements to parse..
			while(statementParts.length > 1)
			{
				// Move the first statement to its own variable.
				const currentStatement = statementParts.shift();

				// Execute the statement handler for the current statement.
				this.messageParser(currentStatement);
			}

			// Store the remaining statement as the current message buffer.
			this.messageBuffer = statementParts.shift();
		}
	}

	/**
	 * Sends a keep-alive message to the host.
	 */
	ping()
	{
		// Craft a keep-alive message.
		const message = ElectrumProtocol.buildRequestObject('server.ping', [], 'keepAlive');

		// Send the keep-alive message.
		return this.send(message);
	}

	/**
	 * Initiates the network connection and configures which higher-level function to use as a message parser.
	 *
	 * @param callback   function to parse incoming message statements.
	 */
	connect(callback)
	{
		// If we are already connected..
		if(this.connected)
		{
			// Return a pre-resolved promise without a value.
			return Promise.resolve();
		}
		else
		{
			// Define a function to wrap connection as a promise.
			const connectionResolver = function(resolve, reject)
			{
				// Add an error handler to resolve the promise on failure.
				this.socket.on('error', resolve, { once: true });

				// Define a function to wrap version negotation as a callback.
				const versionNegotiation = function()
				{
					// Build a version negotiation message.
					const versionMessage = ElectrumProtocol.buildRequestObject('server.version', [ this.application, this.version ], 'versionNegotiation');

					// Define a function to wrap version validation as a function.
					const versionValidation = function(data)
					{
						// Parse the data into a message object.
						const message = JSON.parse(data);

						// Check if version negotiation failed.
						if(typeof message.error !== 'undefined')
						{
							// Disconnect from the host.
							this.disconnect();

							// Reject the connection since version negotiation failed.
							reject(message.error.message);
						}
						else
						{
							// Fetch the host protocol number.
							const hostProtocolVersion = message.result[1];

							// Check if the host supports our requested protocol version.
							if(hostProtocolVersion !== this.version)
							{
								// Disconnect from the host.
								this.disconnect();

								// Reject the connection since it does not support the required version.
								reject(`Incompatible host protocol version negotiated (${hostProtocolVersion} !== ${this.version}).`);
							}
							else
							{
								// Permanently hook the message parse to the provided callback.
								this.messageParser = callback;

								// Resolve the connection promise since we successfully connected and negotiated protocol version.
								resolve(true);
							}
						}
					};

					// Temporarily hook the message parser with the version validation.
					this.messageParser = versionValidation.bind(this);

					// Send the version negotiation message.
					this.send(versionMessage);
				};

				// Connect to the server.
				this.socket.connect(this.port, this.host, versionNegotiation.bind(this));
			};

			// Return a promise that resolves if the connection is established and version negotation succeeds.
			return new Promise(connectionResolver.bind(this));
		}
	}

	/**
	 * Tears down the current connection.
	 *
	 * @param force   disconnect even if the connection has not been fully established yet.
	 * @returns a promise resolving to true if successfully disconnected, or false if there was no connection.
	 */
	disconnect(force = false)
	{
		// Verify that we are connected.
		if(this.connected || force)
		{
			// If a keep-alive timer should be set..
			if(this.keepAlive.limit)
			{
				// Remove the keep-alive timer.
				clearTimeout(this.keepAlive.timer);
			}

			// Close the connection and destroy the socket.
			this.socket.end();
			this.socket.destroy();

			// Set connection status to null to indicate tear-down is currently happening.
			this.connected = null;

			// Return true to indicate that we disconnected.
			return Promise.resolve(true);
		}
		else
		{
			// Return false to indicate that there was nothing to disconnect from.
			return Promise.resolve(false);
		}
	}

	/**
	 * Sends an arbitrary message to the server.
	 *
	 * @param message   json encoded request object to send to the server, as a string.
	 */
	send(message)
	{
		// If a keep-alive timer should be set..
		if(this.keepAlive.limit)
		{
			// Remove the current keep-alive timer.
			clearTimeout(this.keepAlive.timer);

			// Update the timestamp for when we last sent data to the server.
			this.keepAlive.timestamp = Math.floor(Date.now() / 1000);

			// Set a new keep-alive timer.
			this.keepAlive.timer = setTimeout(this.ping.bind(this), this.keepAlive.limit);
		}

		// Write the message to the network socket.
		return this.socket.write(message + ElectrumProtocol.statementDelimiter);
	}

	// --- Event managers. --- //

	/**
	 * Updates the connection status when a connection is confirmed.
	 */
	onConnect()
	{
		// Remove initial connection timeout.
		this.socket.setTimeout(0);

		// Update connection status.
		this.connected = true;

		// If a keep-alive timer should be set..
		if(this.keepAlive.limit)
		{
			// Set up the initial timestamp for when we last sent data to the server.
			this.keepAlive.timestamp = Math.floor(Date.now() / 1000);

			// Set up the initial keep-alive timer.
			this.keepAlive.timer = setTimeout(this.ping.bind(this), this.keepAlive.limit);
		}

		// Write a log message.
		debug.server(`Connected to '${this.host}:${this.port}'.`);
	}

	/**
	 * Updates the connection status when a connection is ended.
	 */
	onDisconnect()
	{
		// Update connection status.
		this.connected = false;

		// If a keep-alive timer should be set..
		if(this.keepAlive.limit)
		{
			// Remove the current keep-alive timer.
			clearTimeout(this.keepAlive.timer);
		}

		// Write a log message.
		debug.server(`Disconnected from '${this.host}:${this.port}'.`);
	}

	/**
	 * Forcibly closes the connection if timed out.
	 */
	onTimeout()
	{
		// Write a log message.
		debug.server(`Connection to '${this.host}:${this.port}' timed out after ${this.timeout} seconds`);

		// Close the network connection.
		this.disconnect(true);
	}

	/**
	 * ...
	 */
	onError(error)
	{
		// TODO: Handle errors.
		debug.errors(`Error ('${this.host}:${this.port}'): `, error);
	}
}

/**
 * High-level Electrum client that lets applications send requests and subscribe to notification events from a server.
 */
class ElectrumClient
{
	/**
	 * Initializes an Electrum client.
	 *
	 * @param application   your application name, used to identify to the electrum host.
	 * @param version       protocol version to use with the host.
	 * @param host          fully qualified domain name or IP number of the host.
	 * @param port          the TCP network port of the host.
	 * @param keepAlive     send a server ping after this time of inactivity, in seconds.
	 * @param retry         when disconnected, attempt to reconnect after this many seconds.
	 * @param timeout       how long to wait for the initial connection before failing, in seconds.
	 */
	constructor(application, version, host, port = 50002, keepAlive = 300, retry = 900, timeout = 10)
	{
		// Set up a connection to an electrum server.
		this.connection = new ElectrumConnection(application, version, host, port, keepAlive, retry, timeout);

		// Initialize request sequence ID to 0.
		this.requestId = 0;

		// Set up an event emitter.
		this.events = new EventEmitter();

		// Set up an empty list of requests.
		this.requestResolvers = {};
	}

	/**
	 * Connects to the remote server.
	 */
	connect()
	{
		// Connect and bind responses to the response callback function.
		return this.connection.connect(this.response.bind(this));
	}

	/**
	 * Disconnects from the remote server.
	 *
	 * @param force   disconnect even if the connection has not been fully established yet.
	 * @returns a promise resolving to true if successfully disconnected, or false if there was no connection.
	 */
	disconnect(force = false)
	{
		// Cancel all event listeners.
		this.events.removeAllListeners();

		// For each pending request..
		for(const index in this.requestResolvers)
		{
			// Reject the request.
			this.requestResolvers[index](new Error('Manual disconnection'));

			// Remove the request.
			delete this.requestResolvers[index];
		}

		// Disconnect from the remove server.
		return this.connection.disconnect(force);
	}

	/**
	 * Calls a method on the remote server with the supplied parameters.
	 *
	 * @param method          name of the method to call.
	 * @param ...parameters   one or more parameters for the method.
	 *
	 * @returns a promise that resolves with the result of the method.
	 */
	request(method, ...parameters)
	{
		// If we are not connected to a server..
		if(!this.connection.connected)
		{
			// Reject the request with a disconnected error message.
			return Promise.reject(new Error(`Unable to send request to a disconnected server '${this.connection.host}'.`));
		}

		// Increase the request ID by one.
		this.requestId += 1;

		// Store a copy of the request id.
		const id = this.requestId;

		// Format the arguments as an electrum request object.
		const message = ElectrumProtocol.buildRequestObject(method, parameters, id);

		// Set up a request promise.
		const requestPromise = function(resolve)
		{
			// Add a request resolver for this promise to the list of requests.
			this.requestResolvers[id] = function(error, data)
			{
				// If the resolution failed..
				if(error)
				{
					// Resolve the promise with the error for the application to handle.
					resolve(error);
				}
				else
				{
					// Resolve the promise with the request results.
					resolve(data);
				}
			};

			// Send the request message to the remote server.
			this.connection.send(message);
		};

		// Write a log message.
		debug.action(`Sending request '${method}' to '${this.connection.host}'`);

		// return a promise to deliver results later.
		return new Promise(requestPromise.bind(this));
	}

	/**
	 * Subscribes to the method at the server and attaches the callback function to the event feed.
	 *
	 * @param callback        a function that should get notification messages.
	 * @param method          one of the subscribable methods the server supports.
	 * @param ...parameters   one or more parameters for the method.
	 * @returns a promise resolving to the initial request response for the subscription.
	 */
	subscribe(callback, method, ...parameters)
	{
		// Define a function resolve the subscription setup process.
		const subscriptionResolver = async function(resolve)
		{
			// Set up event listener for this subscription.
			this.events.addListener(method, callback);

			// Send initial subscription request.
			const requestData = await this.request(method, ...parameters);

			// Manually send the initial request data to the callback.
			callback(requestData);

			// Resolve the subscription promise.
			resolve(true);
		};

		// Return a promise that resolves when the subscription is set up.
		return new Promise(subscriptionResolver.bind(this));
	}

	/**
	 * Parser messages from the remote server to resolve request promises and emit subscription events.
	 */
	response(message)
	{
		// Parse the message into a statement or statement list.
		const statement = JSON.parse(message);

		// Check if the message is a batch result.
		// https://www.jsonrpc.org/specification#batch
		if(Array.isArray(statement))
		{
			// For as long as there is statements in the result set..
			while(statement.length > 0)
			{
				// Move the first statement from the batch to its own variable.
				const currentStatement = statement.shift();

				// Parse the current statement as if it was a new message.
				this.response(JSON.encode(currentStatement));
			}
		}
		else
		{
			// Check if the statement is a keep-alive response..
			if(typeof statement.id !== 'undefined' && statement.id === 'keepAlive')
			{
				// Do nothing.
			}
			else
			{
				// Check if the statement is a request response by verifying if it has a non-null id attribute (but is not a keep-alive message.
				if(typeof statement.id !== 'undefined' && statement.id !== null)
				{
					// Look up which request promise we should resolve this.
					const requestResolver = this.requestResolvers[statement.id];

					// If we do not have a request resolver for this response message..
					if(!requestResolver)
					{
						// Throw an internal error, this should not happen.
						throw('Internal error: Callback for response not available.');
					}
					else
					{
						// Remove the promise from the request list.
						delete this.requestResolvers[statement.id];

						// If the message contains an error..
						if(statement.error)
						{
							// Forward the message error to the request resolver.
							requestResolver(statement.error);
						}
						else
						{
							// Forward the message content to the request resolver.
							requestResolver(null, statement.result);
						}
					}
				}
				else
				{
					// Write a log message.
					debug.action(`Received notification for '${statement.method}' from '${this.connection.host}'`);

					// Forward the message content to all event listeners.
					this.events.emit(statement.method, statement.params);
				}
			}
		}
	}
}

/**
 * High-level electrum client that provides transparent load balancing, confidence checking and/or low-latency polling.
 */
class ElectrumCluster
{
	/**
	 * @returns a list of available ordering settings.
	 */
	static get ORDER()
	{
		const orders =
		{
			RANDOM: null,
			PRIORITY: 1,
		};

		return orders;
	}

	/**
	 * @returns a list of available distribution settings.
	 */
	static get DISTRIBUTION()
	{
		const distributions =
		{
			ALL: 0,
		};

		return distributions;
	}

	/**
	 * @param application    your application name, used to identify to the electrum hosts.
	 * @param version        protocol version to use with the hosts.
	 * @param confidence     wait for this number of hosts to provide identical results.
	 * @param distribution   request information from this number of hosts.
	 * @param order          select hosts to communicate with in this order.
	 * @param keepAlive     send a server ping after this time of inactivity, in seconds.
	 * @param retry         when disconnected, attempt to reconnect after this many seconds.
	 * @param timeout       how long to wait for the initial connection before failing, in seconds.
	 */
	constructor(application, version, confidence = 1, distribution = 0, order = null, keepAlive = 300, retry = 900, timeout = 10)
	{
		// Initialize strategy.
		this.strategy =
		{
			distribution: distribution,
			confidence: confidence,
			order: order,
		};

		// Store the application identifier.
		this.application = application;

		// Store the protocol version requirement.
		this.version = version;

		// Store the keep-alive setting.
		this.keepAlive = keepAlive;

		// Store the retry setting.
		this.retry = retry;

		// Store the setup timeout setting.
		this.timeout = timeout;

		// Set up a list of clients.
		this.clients = {};

		// Set up connection counter.
		this.connections = 0;

		// Set up initial status indicator for the cluster.
		this.status = 0;

		// Set up an event emitter.
		this.events = new EventEmitter();

		// Set up an initial request counter.
		this.requestCounter = 0;

		// Set up an initial list of request promises.
		this.requestPromises = {};

		// Write a log message.
		debug.status(`Initialized empty cluster (${confidence} of ${distribution})`);
	}

	/**
	 * Adds a server to the cluster.
	 *
	 * @param host          fully qualified domain name or IP number of the host.
	 * @param port          the TCP network port of the host.
	 * @returns a promise that resolves when the server is available.
	 */
	addServer(host, port = 50002)
	{
		// Set up a new electrum client.
		const client = new ElectrumClient(this.application, this.version, host, port, this.keepAlive, this.retry, this.timeout);

		// Define a function to run when client has connects.
		const onConnect = function()
		{
			// Set client state to available.
			this.clients[`${host}:${port}`].state = 1;

			// Update connection counter.
			this.connections += 1;

			// If the cluster is not yet ready..
			if(!this.status)
			{
				// Check if we have enough ready connections..
				if(this.connections >= this.strategy.distribution)
				{
					// Mark the cluster as ready.
					this.status = 1;

					// Write a log message.
					debug.status(`Cluster is now ready to use (${this.connections} connections available.)`);
				}
			}
		};

		// Define a function to run when client disconnects.
		const onDisconnect = function()
		{
			// If this was from an established connection..
			if(this.clients[`${host}:${port}`].state)
			{
				// Update connection counter.
				this.connections -= 1;
			}

			// Set client state to unavailable.
			this.clients[`${host}:${port}`].state = 0;

			// If the cluster is considered ready to use..
			if(this.status)
			{
				// Check if we have enough ready connections..
				if(this.connections < this.strategy.distribution)
				{
					// Mark the cluster as degraded.
					this.status = 0;

					// Write a log message.
					debug.status(`Cluster status is degraded (only ${this.connections} of ${this.strategy.distribution} connections available.)`);
				}
			}
		};

		// Set up handlers for connection and disconnection.
		client.connection.socket.on('connect', onConnect.bind(this));
		client.connection.socket.on('close', onDisconnect.bind(this));

		// Store this client.
		this.clients[`${host}:${port}`] =
		{
			state: 0,
			connection: client,
		};

		return client.connect();
	}

	/**
	 * Calls a method on the remote server with the supplied parameters.
	 *
	 * @param method          name of the method to call.
	 * @param ...parameters   one or more parameters for the method.
	 *
	 * @returns a promise that resolves with the result of the method.
	 */
	request(method, ...parameters)
	{
		// Check if the cluster is ready to serve requests.
		if(!this.status)
		{
			//
			throw(new Error(`Cannot request '${method}' when available clients (${this.connections}) is less than required distribution (${Math.max(1, this.strategy.distribution)}).`));
		}

		// Increase the current request counter and make a copy of it.
		// TODO: Make this thread-safe.
		this.requestCounter += 1;
		const requestId = this.requestCounter;

		// Initialize an empty list of request promises.
		this.requestPromises[requestId] = [];

		// Make a copy of the current client list.
		let clientList = Object.keys(this.clients);

		// Initialize a sent counter.
		let sentCounter = 0;

		// Repeat until we have sent the request to the desired number of clients.
		while(sentCounter < this.strategy.distribution)
		{
			// Pick an array index according to our ordering strategy.
			const currentIndex = (this.strategy.order ? 0 : Math.floor(Math.random() * clientList.length));

			// Move a client identity from the client list to its own variable.
			const currentClient = clientList.splice(currentIndex, 1);

			// If this is an available client..
			if(this.clients[currentClient].state)
			{
				// Send the request to the client and store the request promise.
				this.requestPromises[requestId].push(this.clients[currentClient].connection.request(method, ...parameters));

				// Increase the sent counter.
				sentCounter += 1;
			}
		}

		// Define a function to poll for request responses.
		const pollResponse = function(resolve, reject)
		{
			// Define a function to resolve request responses based on integrity.
			const resolveRequest = async function()
			{
				// Set up an empty set of response data.
				let responseData = {};

				// Set up a counter to keep track of how many responses we have checked.
				let checkedResponses = 0;

				// For each server we issued a request to..
				for(const currentPromise in this.requestPromises[requestId])
				{
					// Race the request promise against a pre-resolved request to determine promise status.
					const response = await Promise.race([ this.requestPromises[requestId][currentPromise], Promise.resolve(null) ]);

					// If the promise is settled..
					if(response)
					{
						// Increase the counter for checked responses.
						checkedResponses += 1;

						// Either set the response data counter or increase it.
						if(typeof responseData[response] === 'undefined')
						{
							responseData[response] = 1;
						}
						else
						{
							responseData[response] += 1;
						}

						// Check if this response has enough integrity according to our confidence strategy.
						if(responseData[response] === this.strategy.confidence)
						{
							// Write log entry.
							debug.action(`Validated response for '${method}' with suffient integrity (${this.strategy.confidence}).`);

							// Resolve the request with this response.
							return resolve(response);
						}
					}
				}

				// If all clients have responded but we failed to reach desired integrity..
				if(checkedResponses === this.requestPromises[requestId].length)
				{
					// Reject this request with an error message.
					return reject(new Error(`Unable to complete request for '${method}', response failed to reach sufficient integrity (${this.strategy.confidence}).`));
				}

				// If we are not ready, but have not timed our and should wait more..
				setTimeout(resolveRequest.bind(this), 1000);
			};

			// Attempt the initial resolution of the request.
			resolveRequest.bind(this)();
		};

		// return some kind of promise that resolves when integrity number of clients results match.
		return new Promise(pollResponse.bind(this));
	}

	/**
	 * Subscribes to the method at the cluster and attaches the callback function to the event feed.
	 *
	 * @param callback        a function that should get notification messages.
	 * @param method          one of the subscribable methods the server supports.
	 * @param ...parameters   one or more parameters for the method.
	 * @returns a promise resolving to the initial request response for the subscription.
	 */
	subscribe(callback, method, ...parameters)
	{
		// Define a function resolve the subscription setup process.
		const subscriptionResolver = async function(resolve)
		{
			// Set up an empty set of notification data.
			let notifications = {};

			// Define a callback function to validate server notifications.
			const subscriptionResponse = function(data)
			{
				// Calculate a unique identifier for this notification data.
				const responseDataIdentifier = JSON.stringify(data);

				// Either set the notification counter or increase it.
				if(typeof notifications[responseDataIdentifier] === 'undefined')
				{
					notifications[responseDataIdentifier] = 1;
				}
				else
				{
					notifications[responseDataIdentifier] += 1;
				}

				// Check if this notification has enough integrity according to our confidence strategy.
				if(notifications[responseDataIdentifier] === this.strategy.confidence)
				{
					// Write log entry.
					debug.action(`Validated notification for '${method}' with suffient integrity (${this.strategy.confidence}).`);

					// Send the notification data to the callback function.
					callback(data);
				}
			};

			// Set up event listener for this subscription.
			for(const currentClient in this.clients)
			{
				this.clients[currentClient].connection.events.addListener(method, subscriptionResponse.bind(this));
			}

			// Send initial subscription request.
			const requestData = await this.request(method, ...parameters);

			// Manually send the initial request data to the callback.
			callback(requestData);

			// Resolve the subscription promise.
			resolve(true);
		};

		// Return a promise that resolves when the subscription is set up.
		return new Promise(subscriptionResolver.bind(this));
	}

	/**
	 * Provides a method to check or wait for the cluster to become ready.
	 *
	 * @returns a promise that resolves when the required servers are available.
	 */
	ready()
	{
		// Store the current timestamp.
		const readyTimestamp = Date.now();

		//
		const pollAvailability = function(resolve)
		{
			// Define a function to check if the cluster is ready to be used.
			const verifyConnectionAvailability = function()
			{
				// Check if the cluster is active..
				if(this.status)
				{
					// Resolve with true to indicate that the cluster is ready to use.
					return resolve(true);
				}

				// Calculate how long we have waited, seconds.
				const timeWaited = (Date.now() - readyTimestamp) / 1000;

				// Check if we have waited longer than our timeout setting.
				if(timeWaited > this.timeout)
				{
					// Resolve with false to indicate that we did not get ready in time.
					return resolve(false);
				}

				// If we are not ready, but have not timed our and should wait more..
				setTimeout(verifyConnectionAvailability.bind(this), 50);
			};

			// Run the initial verification.
			verifyConnectionAvailability.bind(this)();
		};

		// Return a promise that resolves when the available clients is suffient.
		return new Promise(pollAvailability.bind(this));
	}

	/**
	 * Disconnects all servers from the cluster.
	 */
	shutdown()
	{
		// Write a log message.
		debug.status('Shutting down cluster.');

		// Mark the cluster as no longer usable.
		this.status = 0;

		// Set up a list of disconnections to wait for.
		let disconnections = [];

		// For each client in this cluster..
		for(let clientIndex in this.clients)
		{
			// Force disconnection regardless of current status.
			disconnections.push(this.clients[clientIndex].connection.connection.disconnect(true));
		}

		// Return a promise that resolves when all disconnections are completed.
		return Promise.allSettled(disconnections);
	}
}

module.exports =
{
	Client: ElectrumClient,
	Cluster: ElectrumCluster
};
