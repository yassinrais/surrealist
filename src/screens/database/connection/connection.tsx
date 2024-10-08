import posthog from "posthog-js";
import { Surreal, ScopeAuth, Uuid, decodeCbor, VersionRetrievalFailure, UnsupportedVersion } from 'surrealdb';
import { AuthDetails, Connection, Protocol } from '~/types';
import { State, useDatabaseStore } from '~/stores/database';
import { getActiveConnection, getAuthDB, getAuthNS, getConnection } from '~/util/connection';
import { connectionUri, newId, showError, showWarning } from '~/util/helpers';
import { syncDatabaseSchema } from '~/util/schema';
import { ConnectedEvent, DisconnectedEvent } from '~/util/global-events';
import { useInterfaceStore } from "~/stores/interface";
import { useConfigStore } from "~/stores/config";
import { getLiveQueries, parseIdent } from "~/util/surrealql";
import { Value } from "@surrealdb/ql-wasm";
import { adapter } from "~/adapter";
import { useCloudStore } from "~/stores/cloud";
import { SANDBOX } from "~/constants";
import { CloudError } from "~/util/errors";
import { createPlaceholder, createSurreal } from "./surreal";
import { buildScopeAuth, composeAuthentication, getReconnectInterval, getVersionTimeout, mapResults } from "./helpers";

export interface ConnectOptions {
	connection?: Connection;
	isRetry?: boolean;
}

export interface UserQueryOptions {
	override?: string;
}

export interface GraphqlResponse {
	success: boolean;
	result: any;
}

let openedConnection: Connection;
let instance = createPlaceholder();
let hasFailed = false;
let forceClose = false;
let retryTask: any;

const LQ_SUPPORTED = new Set<Protocol>(['ws', 'wss', 'mem', 'indxdb']);
const LIVE_QUERIES = new Map<string, Set<Uuid>>();

/**
 * Open a new connection to the data
 *
 * @param options Connection options
 */
export async function openConnection(options?: ConnectOptions) {
	const currentConnection = getConnection();
	const connection = options?.connection || currentConnection;

	if (!connection) {
		throw new Error("No connection available");
	}

	const isRetry = hasFailed && options?.isRetry;
	const newState = isRetry ? "retrying" : "connecting";
	const surreal = await createSurreal();

	await closeConnection(newState);

	instance = surreal;
	openedConnection = connection;
	forceClose = false;

	const { setCurrentState, setVersion, setLatestError } = useDatabaseStore.getState();
	const rpcEndpoint = connectionUri(connection.authentication);
	const thisInstance = instance;

	adapter.log('DB', `Opening connection to ${rpcEndpoint}`);

	if (retryTask) {
		clearTimeout(retryTask);
		retryTask = undefined;
	}

	instance.emitter.subscribe("disconnected", () => {
		DisconnectedEvent.dispatch(null);

		if (instance === thisInstance) {
			setCurrentState(forceClose ? "disconnected" : "retrying");
			setVersion("");
		}

		if (!forceClose) {
			scheduleReconnect();
		}
	});

	try {
		const isSignup = connection.authentication.mode === "scope-signup";
		const [versionCheck, versionCheckTimeout] = getVersionTimeout();

		if (connection.authentication.mode === "cloud") {
			const { authState } = useCloudStore.getState();

			if (authState === "loading") {
				scheduleReconnect(1000);
				return;
			} else if(authState === "unauthenticated") {
				throw new CloudError("Not authenticated with Surreal Cloud");
			}
		}
		const namespace = getAuthNS(connection.authentication) || connection.lastNamespace;
		const database = getAuthDB(connection.authentication) || connection.lastDatabase;

		await instance.connect(rpcEndpoint, {
			versionCheck,
			versionCheckTimeout,
			prepare: async (surreal) => {
				try {
					const auth = await composeAuthentication(connection.authentication);

					if (isSignup) {
						await register(buildScopeAuth(connection.authentication), surreal);
					} else {
						await authenticate(auth, surreal);
					}
				} catch(err) {
					throw new Error(`Authentication failed: ${err}`);
				}
			},
		});

		if (instance === thisInstance) {
			setCurrentState("connected");
			setLatestError("");

			ConnectedEvent.dispatch(null);

			posthog.capture('connection_open', {
				protocol: connection.authentication.protocol
			});

			adapter.log('DB', "Connection established");

			instance.version().then((v) => {
				const version = v.replace(/^surrealdb-/, "");

				setVersion(version);
				adapter.log('DB', `Database version ${version ?? "unknown"}`);
			});

			hasFailed = false;

			if (connection.id === SANDBOX) {
				await instance.use({
					namespace: "sandbox",
					database: "sandbox"
				});
			} else {
				await activateDatabase(namespace, database);
			}
		}
	} catch(err: any) {
		if (instance === thisInstance) {
			instance.close();

			setLatestError(err.message);

			if (!hasFailed) {
				if (err instanceof VersionRetrievalFailure) {
					showWarning({
						title: "Failed to query version",
						subtitle: "The database version could not be determined. Please ensure the database is running and accessible by Surrealist."
					});
				} else if (err instanceof UnsupportedVersion) {
					showError({
						title: "Unsupported version",
						subtitle: `The database version must be in range "${err.supportedRange}". The current version is ${err.version}`
					});
				} else if (!(err instanceof CloudError)) {
					showError({
						title: "Connection failed",
						subtitle: err.message
					});
				}
			}

			hasFailed = true;
		}
	}
}

/**
 * Returns whether the connection is considered active
 */
export function isConnected() {
	return instance.status === "connected" || instance.status === "connecting";
}

/**
 * Close the active surreal connection
 *
 * @param state The state to set after closing
 */
export async function closeConnection(state?: State) {
	const { setCurrentState, setVersion } = useDatabaseStore.getState();
	const status = instance.status;

	if (status === "connected" || status === "connecting") {
		forceClose = true;
		instance.close();
	}

	setCurrentState(state ?? "disconnected");
	setVersion("");
}

/**
 * Register a new scope user
 *
 * @param auth The authentication details
 * @param surreal The optional surreal instance
 */
export async function register(auth: ScopeAuth, surreal?: Surreal) {
	surreal ??= instance;

	await surreal.signup(auth).catch(() => {
		throw new Error("Could not sign up");
	});
}

/**
 * Authenticate the connection
 *
 * @param auth The authentication details
 * @param surreal The optional surreal instance
 */
export async function authenticate(auth: AuthDetails, surreal?: Surreal) {
	surreal ??= instance;

	if (auth === undefined) {
		await surreal.invalidate();
	} else if (typeof auth === "string") {
		await surreal.authenticate(auth).catch(() => {
			throw new Error("Authentication token invalid");
		});
	} else if (auth) {
		await surreal.signin(auth).catch(err => {
			const { openScopeSignup } = useInterfaceStore.getState();

			if (err.message.includes("No record was returned")) {
				openScopeSignup();
			} else {
				throw new Error(err.message);
			}
		});
	}
}

/**
 * Execute a query against the active connection
 */
export async function executeQuery(query: string, params?: any) {
	try {
		const responseRaw = await instance.query_raw(query, params) || [];

		return mapResults(responseRaw);
	} catch(err: any) {
		return [{
			success: false,
			result: err.message,
			execution_time: ''
		}];
	}
}

/**
 * Execute a query against the active connection and
 * return the first response
 */
export async function executeQueryFirst(query: string) {
	const results = await executeQuery(query);
	const { success, result } = results[0];

	if (success) {
		return result;
	} else {
		throw new Error(result);
	}
}

/**
 * Execute a query against the active connection and
 * return the first record of the first response
 */
export async function executeQuerySingle<T = any>(query: string): Promise<T> {
	const results = await executeQuery(query);
	const { success, result } = results[0];

	if (success) {
		return Array.isArray(result) ? result[0] : result;
	} else {
		throw new Error(result);
	}
}

/**
 * Execute a query against the active connection
 *
 * @param options Query options
 */
export async function executeUserQuery(options?: UserQueryOptions) {
	const { setIsLive, pushLiveQueryMessage, clearLiveQueryMessages } = useInterfaceStore.getState();
	const { setQueryActive, currentState, setQueryResponse } = useDatabaseStore.getState();
	const { addHistoryEntry } = useConfigStore.getState();
	const connection = getConnection();

	if (!connection || currentState !== "connected") {
		showError({
			title: "Failed to execute",
			subtitle: "You must be connected to the database"
		});
		return;
	}

	const tabQuery = connection.queries.find((q) => q.id === connection.activeQuery);

	if (!tabQuery) {
		return;
	}

	const { id, query, variables, name } = tabQuery;
	const queryStr = (options?.override || query).trim();
	const variableJson = variables
		? decodeCbor(Value.from_string(variables).to_cbor().buffer)
		: undefined;

	if (query.length === 0) {
		return;
	}

	try {
		setQueryActive(true);

		let liveIndexes: number[];

		try {
			liveIndexes = getLiveQueries(queryStr);
		} catch(err: any) {
			adapter.warn('DB', `Failed to parse live queries: ${err.message}`);
			console.error(err);
			liveIndexes = [];
		}

		if (liveIndexes.length > 0 && !LQ_SUPPORTED.has(connection.authentication.protocol)) {
			showError({
				title: "Live queries unsupported",
				subtitle: "Unfortunately live queries are not supported in the active connection protocol"
			});
		}

		const response = await executeQuery(queryStr, variableJson) || [];
		const liveIds = liveIndexes.flatMap(idx => {
			const res = response[idx];

			if (!res.success || !(res.result instanceof Uuid)) {
				return [];
			}

			return [res.result];
		});

		cancelLiveQueries(id);
		clearLiveQueryMessages(id);
		setIsLive(id, liveIds.length > 0);

		LIVE_QUERIES.set(id, new Set(liveIds));

		const timestamp = Date.now();

		for (const queryId of liveIds) {
			instance.subscribeLive(queryId, (action, data) => {
				pushLiveQueryMessage(id, {
					id: newId(),
					queryId: queryId.toString(),
					action,
					data,
					timestamp
				});
			});
		}

		setQueryResponse(id, response);
		posthog.capture('query_execute');
	} finally {
		setQueryActive(false);
	}

	addHistoryEntry({
		id: newId(),
		query: queryStr,
		timestamp: Date.now(),
		origin: name
	});
}

/**
 * Execute a GraphQL query against the active connection
 */
export async function executeGraphql(query: string, params?: Record<string, any>, operation?: string): Promise<GraphqlResponse> {
	const { currentState } = useDatabaseStore.getState();
	const connection = getConnection();

	if (!connection || currentState !== "connected") {
		showError({
			title: "Failed to execute",
			subtitle: "You must be connected to the database"
		});

		throw new Error("Not connected");
	}

	try {
		const { result, error } = await instance.graphql({
			query,
			variables: params,
			operationName: operation
		});

		return {
			success: !!result,
			result: result || error
		};
	} catch(err: any) {
		return {
			success: false,
			result: err.message
		};
	}
}

/**
 * Cancel the active live queries for the given query ID
 */
export function cancelLiveQueries(tab: string) {
	const { setIsLive } = useInterfaceStore.getState();

	for (const id of LIVE_QUERIES.get(tab) || []) {
		instance.kill(id);
	}

	setIsLive(tab, false);
}

/**
 * Activate the given database within the specified namespace
 */
export async function activateDatabase(namespace: string, database: string) {
	const { updateCurrentConnection } = useConfigStore.getState();
	const { clearSchema } = useDatabaseStore.getState();

	// Clear the previous database schema
	clearSchema();

	// Select a namespace only
	if (namespace) {
		const result = await executeQuerySingle("INFO FOR KV");
		const namespaces = Object.keys(result?.namespaces ?? {}).map(ns => parseIdent(ns));

		if (namespaces.includes(namespace)) {
			updateCurrentConnection({
				lastNamespace: namespace,
				lastDatabase: database
			});

			await instance.use({
				namespace,
				database: null
			});
		} else {
			updateCurrentConnection({
				lastNamespace: "",
				lastDatabase: ""
			});

			return;
		}
	} else {
		updateCurrentConnection({
			lastNamespace: "",
			lastDatabase: ""
		});

		return;
	}

	// Select a database
	if (namespace && database) {
		const result = await executeQuerySingle("INFO FOR NS");
		const databases = Object.keys(result?.databases ?? {}).map(db => parseIdent(db));

		if (databases.includes(database)) {
			updateCurrentConnection({
				lastDatabase: database
			});

			await instance.use({ database });
			await syncDatabaseSchema();
		} else {
			updateCurrentConnection({
				lastDatabase: ""
			});
		}
	}
}

/**
 * The connection instance currently in use
 */
export function getOpenConnection() {
	return openedConnection;
}

function scheduleReconnect(timeout?: number) {
	const reconnectInterval = getReconnectInterval();
	const delay = timeout ?? reconnectInterval;

	retryTask = setTimeout(() => {
		const { currentState } = useDatabaseStore.getState();

		if (currentState !== "connected") {
			openConnection({
				connection: getActiveConnection(),
				isRetry: true
			});
		}
	}, delay);
}