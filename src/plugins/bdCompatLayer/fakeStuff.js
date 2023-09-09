/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { addLogger, evalInScope, findFirstLineWithoutX, simpleGET } from "./utils";

export const FakeEventEmitter = class {
    constructor() {
        this.callbacks = {};
    }

    on(event, cb) {
        if (!this.callbacks[event]) this.callbacks[event] = [];
        this.callbacks[event].push(cb);
    }

    off(event, cb) {
        const cbs = this.callbacks[event];
        if (cbs) {
            this.callbacks[event] = cbs.filter(callback => callback !== cb);
        }
    }

    emit(event, data) {
        const cbs = this.callbacks[event];
        if (cbs) {
            cbs.forEach(cb => cb(data));
        }
    }
};

export const addDiscordModules = proxyUrl => {
    const context = {
        get WebpackModules() {
            return BdApi.Webpack;
        }
    };
    const ModuleDataText = simpleGET(
        proxyUrl +
        "https://github.com/BetterDiscord/BetterDiscord/raw/main/renderer/src/modules/discordmodules.js"
    ).responseText.replaceAll("\r", "");
    const ev =
        "(" +
        ModuleDataText.split("export default Utilities.memoizeObject(")[1];
    const sourceBlob = new Blob([ev], { type: "application/javascript" });
    const sourceBlobUrl = URL.createObjectURL(sourceBlob);
    return { output: evalInScope(ev + "\n//# sourceURL=" + sourceBlobUrl, context), sourceBlobUrl };
};

export const addContextMenu = (DiscordModules, proxyUrl) => {
    /**
     * @type {string}
     */
    const ModuleDataText = simpleGET(
        proxyUrl +
        "https://github.com/BetterDiscord/BetterDiscord/raw/main/renderer/src/modules/api/contextmenu.js"
    ).responseText.replaceAll("\r", "");
    const context = {
        get WebpackModules() {
            return BdApi.Webpack;
        },
        DiscordModules,
        get Patcher() {
            return BdApi.Patcher;
        }
    };
    const linesToRemove = findFirstLineWithoutX(
        ModuleDataText,
        "import"
    );
    // eslint-disable-next-line prefer-const
    let ModuleDataArr = ModuleDataText.split("\n");
    ModuleDataArr.splice(0, linesToRemove);
    ModuleDataArr.pop();
    ModuleDataArr.pop();
    // for (let i = 0; i < ModuleDataArr.length; i++) {
    //     const element = ModuleDataArr[i];
    //     if (element.trimStart().startsWith("Patcher.before(\"ContextMenuPatcher\", ")) {
    //         ModuleDataArr[i] = "debugger;" + element;
    //     }
    // }
    const ModuleDataAssembly =
        "(()=>{" +
        addLogger.toString() +
        ";const Logger = " + addLogger.name + "();const {React} = DiscordModules;" +
        ModuleDataArr.join("\n") +
        "\nreturn ContextMenu;})();";
    const sourceBlob = new Blob([ModuleDataAssembly], {
        type: "application/javascript",
    });
    const sourceBlobUrl = URL.createObjectURL(sourceBlob);
    const evaluatedContextMenu = evalInScope(ModuleDataAssembly + "\n//# sourceURL=" + sourceBlobUrl, context);
    return { output: new evaluatedContextMenu(), sourceBlobUrl };
};

export class Patcher {
    static setup(DiscordModules) {
        this.DiscordModules = DiscordModules;
    }

    static get patches() {
        return this._patches || (this._patches = []);
    }

    /**
     * Returns all the patches done by a specific caller
     * @param {string} name - Name of the patch caller
     * @method
     */
    static getPatchesByCaller(name) {
        if (!name) return [];
        const patches = [];
        for (const patch of this.patches) {
            for (const childPatch of patch.children) {
                if (childPatch.caller === name)
                    patches.push(childPatch);
            }
        }
        return patches;
    }

    /**
     * Unpatches all patches passed, or when a string is passed unpatches all
     * patches done by that specific caller.
     * @param {Array|string} patches - Either an array of patches to unpatch or a caller name
     */
    static unpatchAll(patches) {
        if (typeof patches === "string")
            patches = this.getPatchesByCaller(patches);

        for (const patch of patches) {
            patch.unpatch();
        }
    }

    static resolveModule(module) {
        if (
            !module ||
            typeof module === "function" ||
            (typeof module === "object" && !Array.isArray(module))
        )
            return module;
        if (typeof module === "string") return this.DiscordModules[module];
        if (Array.isArray(module))
            return BdApi.Webpack.findByUniqueProperties(module);
        return null;
    }

    static makeOverride(patch) {
        return function () {
            let returnValue;
            if (!patch.children || !patch.children.length)
                return patch.originalFunction.apply(this, arguments);
            for (const superPatch of patch.children.filter(
                c => c.type === "before"
            )) {
                try {
                    superPatch.callback(this, arguments);
                } catch (err) {
                    console.error(
                        "Patcher",
                        `Could not fire before callback of ${patch.functionName} for ${superPatch.caller}`,
                        err
                    );
                }
            }

            const insteads = patch.children.filter(
                c => c.type === "instead"
            );
            if (!insteads.length) {
                returnValue = patch.originalFunction.apply(
                    this,
                    arguments
                );
            } else {
                for (const insteadPatch of insteads) {
                    try {
                        const tempReturn = insteadPatch.callback(
                            this,
                            arguments,
                            patch.originalFunction.bind(this)
                        );
                        if (typeof tempReturn !== "undefined")
                            returnValue = tempReturn;
                    } catch (err) {
                        console.error(
                            "Patcher",
                            `Could not fire instead callback of ${patch.functionName} for ${insteadPatch.caller}`,
                            err
                        );
                    }
                }
            }

            for (const slavePatch of patch.children.filter(
                c => c.type === "after"
            )) {
                try {
                    const tempReturn = slavePatch.callback(
                        this,
                        arguments,
                        returnValue
                    );
                    if (typeof tempReturn !== "undefined")
                        returnValue = tempReturn;
                } catch (err) {
                    console.error(
                        "Patcher",
                        `Could not fire after callback of ${patch.functionName} for ${slavePatch.caller}`,
                        err
                    );
                }
            }
            return returnValue;
        };
    }

    static rePatch(patch) {
        patch.proxyFunction = patch.module[patch.functionName] =
            this.makeOverride(patch);
    }

    static makePatch(module, functionName, name) {
        const patch = {
            name,
            module,
            functionName,
            originalFunction: module[functionName],
            proxyFunction: null,
            revert: () => {
                // Calling revert will destroy any patches added to the same module after this
                patch.module[patch.functionName] =
                    patch.originalFunction;
                patch.proxyFunction = null;
                patch.children = [];
            },
            counter: 0,
            children: [],
        };
        patch.proxyFunction = module[functionName] =
            this.makeOverride(patch);
        Object.assign(module[functionName], patch.originalFunction);
        module[functionName].__originalFunction =
            patch.originalFunction;
        module[functionName].toString = () =>
            patch.originalFunction.toString();
        this.patches.push(patch);
        return patch;
    }

    /**
     * Function with no arguments and no return value that may be called to revert changes made by {@link module:Patcher}, restoring (unpatching) original method.
     * @callback module:Patcher~unpatch
     */

    /**
     * A callback that modifies method logic. This callback is called on each call of the original method and is provided all data about original call. Any of the data can be modified if necessary, but do so wisely.
     *
     * The third argument for the callback will be `undefined` for `before` patches. `originalFunction` for `instead` patches and `returnValue` for `after` patches.
     *
     * @callback module:Patcher~patchCallback
     * @param {object} thisObject - `this` in the context of the original function.
     * @param {arguments} args - The original arguments of the original function.
     * @param {(function|*)} extraValue - For `instead` patches, this is the original function from the module. For `after` patches, this is the return value of the function.
     * @return {*} Makes sense only when using an `instead` or `after` patch. If something other than `undefined` is returned, the returned value replaces the value of `returnValue`. If used for `before` the return value is ignored.
     */

    /**
     * This method patches onto another function, allowing your code to run beforehand.
     * Using this, you are also able to modify the incoming arguments before the original method is run.
     *
     * @param {string} caller - Name of the caller of the patch function. Using this you can undo all patches with the same name using {@link module:Patcher.unpatchAll}. Use `""` if you don't care.
     * @param {object} moduleToPatch - Object with the function to be patched. Can also patch an object's prototype.
     * @param {string} functionName - Name of the method to be patched
     * @param {module:Patcher~patchCallback} callback - Function to run before the original method
     * @param {object} options - Object used to pass additional options.
     * @param {string} [options.displayName] You can provide meaningful name for class/object provided in `what` param for logging purposes. By default, this function will try to determine name automatically.
     * @param {boolean} [options.forcePatch=true] Set to `true` to patch even if the function doesnt exist. (Adds noop function in place).
     * @return {module:Patcher~unpatch} Function with no arguments and no return value that should be called to cancel (unpatch) this patch. You should save and run it when your plugin is stopped.
     */
    static before(
        caller,
        moduleToPatch,
        functionName,
        callback,
        options = {}
    ) {
        return this.pushChildPatch(
            caller,
            moduleToPatch,
            functionName,
            callback,
            Object.assign(options, { type: "before" })
        );
    }

    /**
     * This method patches onto another function, allowing your code to run after.
     * Using this, you are also able to modify the return value, using the return of your code instead.
     *
     * @param {string} caller - Name of the caller of the patch function. Using this you can undo all patches with the same name using {@link module:Patcher.unpatchAll}. Use `""` if you don't care.
     * @param {object} moduleToPatch - Object with the function to be patched. Can also patch an object's prototype.
     * @param {string} functionName - Name of the method to be patched
     * @param {module:Patcher~patchCallback} callback - Function to run instead of the original method
     * @param {object} options - Object used to pass additional options.
     * @param {string} [options.displayName] You can provide meaningful name for class/object provided in `what` param for logging purposes. By default, this function will try to determine name automatically.
     * @param {boolean} [options.forcePatch=true] Set to `true` to patch even if the function doesnt exist. (Adds noop function in place).
     * @return {module:Patcher~unpatch} Function with no arguments and no return value that should be called to cancel (unpatch) this patch. You should save and run it when your plugin is stopped.
     */
    static after(
        caller,
        moduleToPatch,
        functionName,
        callback,
        options = {}
    ) {
        return this.pushChildPatch(
            caller,
            moduleToPatch,
            functionName,
            callback,
            Object.assign(options, { type: "after" })
        );
    }

    /**
     * This method patches onto another function, allowing your code to run instead.
     * Using this, you are also able to modify the return value, using the return of your code instead.
     *
     * @param {string} caller - Name of the caller of the patch function. Using this you can undo all patches with the same name using {@link module:Patcher.unpatchAll}. Use `""` if you don't care.
     * @param {object} moduleToPatch - Object with the function to be patched. Can also patch an object's prototype.
     * @param {string} functionName - Name of the method to be patched
     * @param {module:Patcher~patchCallback} callback - Function to run after the original method
     * @param {object} options - Object used to pass additional options.
     * @param {string} [options.displayName] You can provide meaningful name for class/object provided in `what` param for logging purposes. By default, this function will try to determine name automatically.
     * @param {boolean} [options.forcePatch=true] Set to `true` to patch even if the function doesnt exist. (Adds noop function in place).
     * @return {module:Patcher~unpatch} Function with no arguments and no return value that should be called to cancel (unpatch) this patch. You should save and run it when your plugin is stopped.
     */
    static instead(
        caller,
        moduleToPatch,
        functionName,
        callback,
        options = {}
    ) {
        return this.pushChildPatch(
            caller,
            moduleToPatch,
            functionName,
            callback,
            Object.assign(options, { type: "instead" })
        );
    }

    /**
     * This method patches onto another function, allowing your code to run before, instead or after the original function.
     * Using this you are able to modify the incoming arguments before the original function is run as well as the return
     * value before the original function actually returns.
     *
     * @param {string} caller - Name of the caller of the patch function. Using this you can undo all patches with the same name using {@link module:Patcher.unpatchAll}. Use `""` if you don't care.
     * @param {object} moduleToPatch - Object with the function to be patched. Can also patch an object's prototype.
     * @param {string} functionName - Name of the method to be patched
     * @param {module:Patcher~patchCallback} callback - Function to run after the original method
     * @param {object} options - Object used to pass additional options.
     * @param {string} [options.type=after] - Determines whether to run the function `before`, `instead`, or `after` the original.
     * @param {string} [options.displayName] You can provide meaningful name for class/object provided in `what` param for logging purposes. By default, this function will try to determine name automatically.
     * @param {boolean} [options.forcePatch=true] Set to `true` to patch even if the function doesnt exist. (Adds noop function in place).
     * @return {module:Patcher~unpatch} Function with no arguments and no return value that should be called to cancel (unpatch) this patch. You should save and run it when your plugin is stopped.
     */
    static pushChildPatch(
        caller,
        moduleToPatch,
        functionName,
        callback,
        options = {}
    ) {
        const { type = "after", forcePatch = true } = options;
        const module = this.resolveModule(moduleToPatch);
        if (!module) return null;
        if (!module[functionName] && forcePatch)
            module[functionName] = function () { };
        if (!(module[functionName] instanceof Function)) return null;

        if (typeof moduleToPatch === "string")
            options.displayName = moduleToPatch;
        const displayName =
            options.displayName ||
            module.displayName ||
            module.name ||
            module.constructor.displayName ||
            module.constructor.name;

        const patchId = `${displayName}.${functionName}`;
        const patch =
            this.patches.find(
                p =>
                    // eslint-disable-next-line eqeqeq
                    p.module == module && p.functionName == functionName
            ) || this.makePatch(module, functionName, patchId);
        if (!patch.proxyFunction) this.rePatch(patch);
        const child = {
            caller,
            type,
            id: patch.counter,
            callback,
            unpatch: () => {
                patch.children.splice(
                    patch.children.findIndex(
                        cpatch =>
                            cpatch.id === child.id &&
                            cpatch.type === type
                    ),
                    1
                );
                if (patch.children.length <= 0) {
                    const patchNum = this.patches.findIndex(
                        p =>
                            // eslint-disable-next-line eqeqeq
                            p.module == module &&
                            // eslint-disable-next-line eqeqeq
                            p.functionName == functionName
                    );
                    if (patchNum < 0) return;
                    this.patches[patchNum].revert();
                    this.patches.splice(patchNum, 1);
                }
            },
        };
        patch.children.push(child);
        patch.counter++;
        return child.unpatch;
    }
}
