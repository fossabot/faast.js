import debug from "debug";
import { Deferred, Pump } from "./funnel";
import { log } from "./log";
import { FunctionCall, FunctionReturn, sleep } from "./shared";

export interface Attributes {
    [key: string]: string;
}

export interface RequestQueueImpl {
    publishMessage(body: string, attributes?: Attributes): Promise<any>;
}

export type ControlMessageType = "stopqueue" | "functionstarted";

const CallIdAttribute = "CallId";

export interface ReceivedMessages<M> {
    Messages: M[];
    isFullMessageBatch: boolean;
}

export interface ResponseQueueImpl<M> {
    receiveMessages(): Promise<ReceivedMessages<M>>;
    getMessageAttribute(message: M, attribute: string): string | undefined;
    getMessageBody(message: M): string;
    description(): string;
    publishControlMessage(type: ControlMessageType, attr?: Attributes): Promise<any>;
    isControlMessage(message: M, type: ControlMessageType): boolean;
}

export type QueueImpl<M> = RequestQueueImpl & ResponseQueueImpl<M>;

export class PendingRequest extends Deferred<FunctionReturn> {
    created: number = Date.now();
    executing?: boolean;
    constructor(readonly callArgsStr: string) {
        super();
    }
}

export interface Vars {
    readonly callResultsPending: Map<string, PendingRequest>;
    readonly collectorPump: Pump<void>;
    readonly retryTimer: NodeJS.Timer;
}

export type StateWithMessageType<M> = Vars & QueueImpl<M>;
export type State = StateWithMessageType<{}>;

export function initializeCloudFunctionQueue<M>(
    impl: QueueImpl<M>
): StateWithMessageType<M> {
    const state: StateWithMessageType<M> = {
        ...impl,
        callResultsPending: new Map(),
        collectorPump: new Pump<void>(2, () => resultCollector(state)),
        retryTimer: setInterval(() => retryQueue(state), 5 * 1000)
    };
    state.collectorPump.start();
    return state;
}

export function enqueueCallRequest(
    state: State,
    callRequest: FunctionCall,
    ResponseQueueId: string
) {
    const request = {
        ...callRequest,
        ResponseQueueId
    };
    const deferred = new PendingRequest(JSON.stringify(request));
    state.callResultsPending.set(callRequest.CallId, deferred);
    state.publishMessage(deferred.callArgsStr);
    return deferred.promise;
}

export async function stop(state: State) {
    state.collectorPump.stop();
    clearInterval(state.retryTimer);
    rejectAll(state.callResultsPending);
    let count = 0;
    const tasks = [];
    while (state.collectorPump.getConcurrency() > 0 && count++ < 100) {
        tasks.push(state.publishControlMessage("stopqueue"));
        await sleep(100);
    }
    await Promise.all(tasks);
}

interface CallResults<M> {
    CallId?: string;
    message: M;
    deferred?: Deferred<FunctionReturn>;
}

async function resultCollector<MessageType>(state: StateWithMessageType<MessageType>) {
    // tslint:disable-next-line:no-shadowed-variable
    const log = debug("cloudify:collector");
    const resolvePromises = (results: Array<CallResults<MessageType>>) => {
        for (const { message, CallId, deferred } of results) {
            if (!CallId) {
                // Can happen when a message is multiply delivered, such as retries. Ignore.
                continue;
            }
            const returned: FunctionReturn = JSON.parse(state.getMessageBody(message));
            returned.rawResponse = message;
            if (deferred) {
                deferred.resolve(returned);
            } else {
                // Caused by retries: CallId returned more than once. Ignore.
                // log(`Deferred promise not found for CallID: ${CallId}`);
            }
        }
    };

    if (state.callResultsPending.size > 0) {
        log(
            `Polling response queue (size ${
                state.callResultsPending.size
            }: ${state.description()}`
        );

        const { Messages, isFullMessageBatch } = await state.receiveMessages();
        log(`received ${Messages.length} messages.`);
        adjustConcurrencyLevel(state, isFullMessageBatch);

        try {
            const callResults: Array<CallResults<MessageType>> = [];
            for (const m of Messages) {
                if (state.isControlMessage(m, "stopqueue")) {
                    return;
                }
                const CallId = state.getMessageAttribute(m, CallIdAttribute);
                if (state.isControlMessage(m, "functionstarted")) {
                    log(`Received Function Started message CallID: ${CallId}`);
                    const deferred = CallId && state.callResultsPending.get(CallId);
                    if (deferred) {
                        deferred!.executing = true;
                    }
                } else {
                    if (CallId) {
                        callResults.push({
                            CallId,
                            message: m,
                            deferred: state.callResultsPending.get(CallId)
                        });
                        state.callResultsPending.delete(CallId);
                    }
                }
            }
            resolvePromises(callResults);
        } catch (err) {
            log(err);
        }
    }
}

// Only used when SNS fails to invoke lambda.
function retryQueue(state: State) {
    const { size } = state.callResultsPending;
    const now = Date.now();
    if (size > 0 && size < 10) {
        for (const [CallId, pending] of state.callResultsPending.entries()) {
            if (!pending.executing) {
                if (now - pending.created > 4 * 1000) {
                    log(`Lambda function not started for CallId ${CallId}, retrying...`);
                    state.publishMessage(pending.callArgsStr);
                }
            }
        }
    }
}

function adjustConcurrencyLevel(vars: Vars, full: boolean) {
    const nPending = vars.callResultsPending.size;
    if (nPending > 0) {
        let nCollectors = full ? Math.floor(nPending / 20) + 2 : 2;
        nCollectors = Math.min(nCollectors, 10);
        const pump = vars.collectorPump;
        const previous = pump.maxConcurrency;
        pump.setMaxConcurrency(nCollectors);
        if (previous !== pump.maxConcurrency) {
            log(
                `Result collectors running: ${pump.getConcurrency()}, new max: ${
                    pump.maxConcurrency
                }`
            );
        }
    }
}

function rejectAll(callResultsPending: Map<string, PendingRequest>) {
    log(`Rejecting ${callResultsPending.size} result promises`);
    for (const [key, promise] of callResultsPending) {
        log(`Rejecting call result: ${key}`);
        promise.reject(
            new Error(
                `Call to cloud function cancelled in cleanup: ${
                    callResultsPending[key].callArgsStr
                }`
            )
        );
    }
    callResultsPending.clear();
}
