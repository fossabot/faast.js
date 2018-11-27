import * as sys from "child_process";
import * as fs from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { promisify } from "util";
import { CloudFunctionImpl, CloudImpl, CommonOptions } from "../cloudify";
import { info, warn } from "../log";
import {
    FunctionCall,
    FunctionReturn,
    FunctionReturnWithMetrics,
    ModuleWrapper,
    serializeCall
} from "../module-wrapper";
import { packer, PackerOptions, PackerResult, unzipInDir } from "../packer";
import { CommonOptionDefaults, rmrf } from "../shared";
import * as immediateTrampolineFactory from "./immediate-trampoline";

const mkdir = promisify(fs.mkdir);
const exec = promisify(sys.exec);

export interface State {
    moduleWrappers: ModuleWrapper[];
    getModuleWrapper: () => ModuleWrapper;
    options: Options;
    tempDir: string;
}

export interface Options extends CommonOptions {
    log?: (msg: string) => void;
}

export const defaults: Options = {
    ...CommonOptionDefaults,
    log: console.log,
    concurrency: 10
};

export const Impl: CloudImpl<Options, State> = {
    name: "immediate",
    initialize,
    pack,
    getFunctionImpl,
    defaults
};

export const FunctionImpl: CloudFunctionImpl<State> = {
    name: "immediate",
    callFunction,
    cleanup,
    stop
};

async function initialize(
    serverModule: string,
    nonce: string,
    options: Options = {}
): Promise<State> {
    const childlog = options.log || defaults.log;
    const moduleWrappers: ModuleWrapper[] = [];
    const getModuleWrapper = () => {
        const idleWrapper = moduleWrappers.find(wrapper => wrapper.executing === false);
        if (idleWrapper) {
            return idleWrapper;
        }
        const moduleWrapper = new ModuleWrapper(require(serverModule), {
            log: childlog,
            useChildProcess: options.childProcess || false
        });
        moduleWrappers.push(moduleWrapper);
        return moduleWrapper;
    };

    const tempDir = path.join(tmpdir(), "cloudify-" + nonce);
    info(`tempDir: ${tempDir}`);
    await mkdir(tempDir, { mode: 0o700, recursive: true });
    process.chdir(tempDir);

    const packerResult = await pack(serverModule, options);

    await unzipInDir(tempDir, packerResult.archive);
    const packageJsonFile = path.join(tempDir, "package.json");
    if (fs.existsSync(packageJsonFile)) {
        info(`Running 'npm install'`);
        await exec("npm install").then(x => {
            info(x.stdout);
            if (x.stderr) {
                warn(x.stderr);
            }
        });
    }

    return {
        moduleWrappers,
        getModuleWrapper,
        options,
        tempDir
    };
}

async function pack(functionModule: string, options?: Options): Promise<PackerResult> {
    const popts: PackerOptions = options || {};
    return packer(immediateTrampolineFactory, functionModule, popts);
}

function getFunctionImpl(): CloudFunctionImpl<State> {
    return FunctionImpl;
}

async function callFunction(
    state: State,
    call: FunctionCall
): Promise<FunctionReturnWithMetrics> {
    const scall = JSON.parse(serializeCall(call));
    const startTime = Date.now();
    let returned: FunctionReturn;
    process.chdir(state.tempDir);
    returned = await state.getModuleWrapper().execute({ call: scall, startTime });

    return {
        returned,
        rawResponse: {},
        localRequestSentTime: startTime,
        remoteResponseSentTime: returned.remoteExecutionEndTime!,
        localEndTime: Date.now()
    };
}

async function cleanup(state: State): Promise<void> {
    await stop(state);
    const { tempDir } = state;
    if (tempDir && tempDir.match(/\/cloudify-/) && fs.existsSync(tempDir)) {
        info(`Deleting temp dir ${tempDir}`);
        await rmrf(tempDir);
    }
}

async function stop(state: State) {
    info(`Stopping`);
    const promises = state.moduleWrappers.map(wrapper => wrapper.stop());
    await Promise.all(promises);
    state.moduleWrappers = [];
    info(`Stopping done`);
}
