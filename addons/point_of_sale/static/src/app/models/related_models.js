import { toRaw } from "@odoo/owl";
import { uuidv4 } from "@point_of_sale/utils";
import { TrapDisabler } from "@point_of_sale/proxy_trap";
import { WithLazyGetterTrap } from "@point_of_sale/lazy_getter";

const ID_CONTAINER = {};

function uuid(model) {
    if (!(model in ID_CONTAINER)) {
        ID_CONTAINER[model] = 1;
    }
    return `${model}_${ID_CONTAINER[model]++}`;
}

function getBackRef(model, fieldName) {
    return `<-${model}.${fieldName}`;
}

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function mapObj(obj, fn) {
    return Object.fromEntries(Object.entries(obj).map(([k, v], i) => [k, fn(k, v, i)]));
}

const RELATION_TYPES = new Set(["many2many", "many2one", "one2many"]);
const X2MANY_TYPES = new Set(["many2many", "one2many"]);
const AVAILABLE_EVENT = ["create", "update", "delete"];

function processModelDefs(modelDefs) {
    modelDefs = clone(modelDefs);
    const inverseMap = new Map();
    const many2oneFields = [];
    const baseData = {};
    for (const model in modelDefs) {
        const fields = modelDefs[model];
        if (!baseData[model]) {
            baseData[model] = {};
        }
        for (const fieldName in fields) {
            const field = fields[fieldName];

            // Make sure that the field has a name and consistent with the key.
            if (field.name) {
                if (fieldName !== field.name) {
                    throw new Error(`Field name mismatch: ${fieldName} !== ${field.name}`);
                }
            } else {
                field.name = fieldName;
            }

            if (!RELATION_TYPES.has(field.type)) {
                continue;
            }

            if (inverseMap.has(field)) {
                continue;
            }

            const comodel = modelDefs[field.relation];
            if (!comodel) {
                continue;
                // throw new Error(`Model ${field.relation} not found`);
            }

            if (field.type === "many2many") {
                let [inverseField, ...others] = Object.values(comodel).filter(
                    (f) =>
                        model === f.relation &&
                        f.relation_table === field.relation_table &&
                        field.name !== f.name
                );
                if (others.length > 0) {
                    throw new Error("Many2many relation must have only one inverse");
                }
                if (!inverseField) {
                    const backRefName = getBackRef(model, field.name);
                    inverseField = {
                        name: backRefName,
                        type: "many2many",
                        relation: model,
                        inverse_name: field.name,
                        dummy: true,
                    };
                    comodel[backRefName] = inverseField;
                }
                inverseMap.set(field, inverseField);
                inverseMap.set(inverseField, field);
            } else if (field.type === "one2many") {
                let inverseField = Object.values(comodel).find(
                    (f) => f.relation === model && f.name === field.inverse_name
                );
                if (!inverseField) {
                    const backRefName = getBackRef(model, field.name);
                    inverseField = {
                        name: backRefName,
                        type: "many2one",
                        relation: model,
                        inverse_name: field.name,
                        dummy: true,
                    };
                    comodel[backRefName] = inverseField;
                }
                inverseMap.set(field, inverseField);
                inverseMap.set(inverseField, field);
            } else if (field.type === "many2one") {
                many2oneFields.push([model, field]);
            }
        }
    }

    for (const [model, field] of many2oneFields) {
        if (inverseMap.has(field)) {
            continue;
        }

        const comodel = modelDefs[field.relation];
        if (!comodel) {
            continue;
            // throw new Error(`Model ${field.relation} not found`);
        }

        const dummyName = getBackRef(model, field.name);
        const dummyField = {
            name: dummyName,
            type: "one2many",
            relation: model,
            inverse_name: field.name,
            dummy: true,
        };
        comodel[dummyName] = dummyField;
        inverseMap.set(field, dummyField);
        inverseMap.set(dummyField, field);
    }
    return [inverseMap, modelDefs, baseData];
}

export class Base extends WithLazyGetterTrap {
    constructor({ models, records, model, traps, dynamicModels, baseData }) {
        super({ traps });
        this.models = models;
        this.records = records;
        this.model = model;
        this._dynamicModels = dynamicModels;
        this.baseData = baseData;
        this._indexMaps = {};
    }
    /**
     * Called during instantiation when the instance is fully-populated with field values.
     * Check @create inside `createRelatedModels` below.
     * @param {*} _vals
     */
    setup(_vals) {
        // Allow custom fields
        for (const [key, val] of Object.entries(_vals)) {
            // Prevent extra fields that begin by _ to be overrided
            if (key in this.model.modelFields) {
                continue;
            }

            if (key.startsWith("_") && !key.startsWith("__")) {
                this[key] = val;
            }
        }
    }

    setDirty() {
        if (typeof this.id === "number") {
            this.models.commands[this.model.modelName].update.add(this.id);
        }
    }

    setupState(vals) {
        this.uiState = vals;
    }

    serializeState() {
        return { ...this.uiState };
    }

    update(vals, opts = {}) {
        this.model.update(this, vals, opts);
    }
    delete(opts = {}) {
        return this.model.delete(this, opts);
    }
    /**
     * @param {object} options
     * @param {boolean} options.orm - [true] if result is to be sent to the server
     */
    serialize(options = {}) {
        const orm = options.orm ?? false;
        const clear = options.clear ?? false;

        const serializedData = this.model.serialize(this, { orm });

        if (orm) {
            const fields = this.model.modelFields;
            const serializedDataOrm = {};

            // We only care about the fields present in python model
            for (const [name, params] of Object.entries(fields)) {
                if (params.dummy) {
                    continue;
                }
                if (params.local || params.related || params.compute) {
                    continue;
                }

                if (X2MANY_TYPES.has(params.type)) {
                    serializedDataOrm[name] = serializedData[name]
                        .map((id) => {
                            let serData = false;
                            let data = {};

                            if (
                                !this._dynamicModels.includes(params.relation) &&
                                typeof id === "number"
                            ) {
                                return [4, id];
                            } else if (!this._dynamicModels.includes(params.relation)) {
                                throw new Error(
                                    "Trying to create a non serializable record" + params.relation
                                );
                            }

                            if (params.relation !== params.model) {
                                data = this.records[params.relation].get(id).serialize(options);
                                data.id = typeof id === "number" ? id : parseInt(id.split("_")[1]);
                            } else {
                                return typeof id === "number" ? id : parseInt(id.split("_")[1]);
                            }

                            if (
                                typeof id === "number" &&
                                this.models.commands[params.relation].update.has(id)
                            ) {
                                serData = [1, id, data];

                                if (clear) {
                                    this.models.commands[params.relation].update.delete(id);
                                }
                            } else if (typeof id !== "number") {
                                serData = [0, 0, data];
                            }

                            if (serData) {
                                for (const [key, value] of Object.entries(serData[2])) {
                                    if (
                                        this.models[params.relation].modelFields[key]?.relation &&
                                        typeof value === "string"
                                    ) {
                                        serData[2][key] = parseInt(value.split("_")[1]);
                                    }
                                }
                            }

                            return serData;
                        })
                        .filter((s) => s);

                    if (
                        this.models.commands[params.model].unlink.has(name) ||
                        this.models.commands[params.model].delete.has(name)
                    ) {
                        const unlinks = this.models.commands[params.model].unlink.get(name);
                        const deletes = this.models.commands[params.model].delete.get(name);
                        for (const id of unlinks || []) {
                            serializedDataOrm[name].push([3, id]);
                        }
                        for (const id of deletes || []) {
                            serializedDataOrm[name].push([2, id]);
                        }
                        if (clear) {
                            this.models.commands[params.model].unlink.delete(name);
                            this.models.commands[params.model].delete.delete(name);
                        }
                    }
                } else {
                    let value = serializedData[name];
                    if (name === "id" && typeof value === "string") {
                        value = serializedData[name].split("_")[1];
                    }
                    serializedDataOrm[name] = value !== undefined ? value : false;
                }
            }

            return serializedDataOrm;
        }

        return serializedData;
    }
    getIndexMaps(fieldName) {
        if (!this._indexMaps[fieldName]) {
            this._indexMaps[fieldName] = new Map();
        }
        return this._indexMaps[fieldName];
    }
    get raw() {
        return this.baseData[this.id];
    }
}

export function createRelatedModels(modelDefs, modelClasses = {}, opts = {}) {
    const indexes = opts.databaseIndex || {};
    const database = opts.databaseTable || {};
    const [inverseMap, processedModelDefs, baseData] = processModelDefs(modelDefs);
    const records = mapObj(processedModelDefs, () => new Map());
    const callbacks = mapObj(processedModelDefs, () => []);
    const commands = mapObj(processedModelDefs, () => ({
        delete: new Map(),
        unlink: new Map(),
        update: new Set(),
    }));
    const missingFields = {};

    // object: model -> key -> keyval -> record
    const indexedRecords = mapObj(processedModelDefs, (model) => {
        const container = {};

        // We always want an index by id
        if (!indexes[model]) {
            indexes[model] = ["id"];
        } else {
            indexes[model].push("id");
        }

        for (const key of indexes[model] || []) {
            container[key] = {};
        }

        return container;
    });

    function getFields(model) {
        return processedModelDefs[model];
    }

    function removeItem(record, fieldName, item) {
        if (typeof record !== "object") {
            return;
        }

        const indexMap = record.getIndexMaps(fieldName);
        const key = database[item.model.modelName]?.key || "id";
        const keyVal = item[key];
        const existingIndex = indexMap.get(keyVal);

        if (existingIndex !== undefined) {
            indexMap.delete(keyVal);
            record[fieldName].splice(existingIndex, 1);

            // update indexes for items after existingIndex
            for (let i = existingIndex; i < record[fieldName].length; i++) {
                const shiftedItem = record[fieldName][i];
                const shiftedKeyVal = shiftedItem[key];
                indexMap.set(shiftedKeyVal, i);
            }
        }
    }

    function addItem(record, fieldName, item) {
        const indexMap = record.getIndexMaps(fieldName);
        const key = database[item.model.modelName]?.key || "id";
        const keyVal = item[key];
        if (!keyVal) {
            console.warn(`Key ${key} not found in ${item.model.modelName}`);
        }
        const existingIndex = indexMap.get(keyVal);
        if (existingIndex === undefined) {
            record[fieldName].push(item);
            indexMap.set(keyVal, record[fieldName].length - 1);
        } else {
            record[fieldName][existingIndex] = item;
        }
    }

    function connect(field, ownerRecord, recordToConnect) {
        const inverse = inverseMap.get(field);

        if (typeof ownerRecord !== "object") {
            const model = field.model;
            ownerRecord = records[model].get(ownerRecord);
        }

        if (typeof recordToConnect !== "object") {
            const model = field.relation;
            recordToConnect = records[model].get(recordToConnect);
        }

        if (field.type === "many2one") {
            const prevConnectedRecord = ownerRecord[field.name];
            if (toRaw(prevConnectedRecord) === toRaw(recordToConnect)) {
                return;
            }
            if (recordToConnect && inverse.name in recordToConnect) {
                addItem(recordToConnect, inverse.name, ownerRecord);
            }
            if (prevConnectedRecord) {
                removeItem(prevConnectedRecord, inverse.name, ownerRecord);
            }
            ownerRecord[field.name] = recordToConnect;
        } else if (field.type === "one2many") {
            // It's necessary to remove the previous connected in one2many but it would cause issue for inherited one2many field.
            // Also, we don't do modification in PoS and we can ignore the removing part to prevent issue.
            recordToConnect[inverse.name] = ownerRecord;
            addItem(ownerRecord, field.name, recordToConnect);
        } else if (field.type === "many2many") {
            addItem(ownerRecord, field.name, recordToConnect);
            addItem(recordToConnect, inverse.name, ownerRecord);
        }
    }

    function disconnect(field, ownerRecord, recordToDisconnect) {
        if (!recordToDisconnect) {
            throw new Error("recordToDisconnect is undefined");
        }
        const inverse = inverseMap.get(field);
        if (field.type === "many2one") {
            const prevConnectedRecord = ownerRecord[field.name];
            if (prevConnectedRecord === recordToDisconnect) {
                ownerRecord[field.name] = undefined;
                removeItem(recordToDisconnect, inverse.name, ownerRecord);
            }
        } else if (field.type === "one2many") {
            removeItem(ownerRecord, field.name, recordToDisconnect);
            const prevConnectedRecord = recordToDisconnect[inverse.name];
            if (prevConnectedRecord === ownerRecord) {
                recordToDisconnect[inverse.name] = undefined;
            }
        } else if (field.type === "many2many") {
            removeItem(ownerRecord, field.name, recordToDisconnect);
            removeItem(recordToDisconnect, inverse.name, ownerRecord);
        }
    }

    function exists(model, id) {
        return model in records && records[model].has(id);
    }

    /**
     * This check assumes that if the first element is a command, then the rest are commands.
     */
    function isX2ManyCommands(value) {
        return (
            Array.isArray(value) &&
            Array.isArray(value[0]) &&
            ["unlink", "clear", "create", "link"].includes(value[0][0])
        );
    }

    const disabler = new TrapDisabler();
    function withoutProxyTrap(fn) {
        return (...args) => disabler.call(fn, ...args);
    }

    const setTrapsCache = {};
    function instantiateModel(model, { models, records }) {
        const fields = getFields(model);
        const Model = modelClasses[model] || Base;
        if (!(model in setTrapsCache)) {
            setTrapsCache[model] = function setTrap(target, prop, value, receiver) {
                if (disabler.isDisabled() || !(prop in fields)) {
                    return Reflect.set(target, prop, value, receiver);
                }
                return disabler.call(() => {
                    const field = fields[prop];
                    if (field && X2MANY_TYPES.has(field.type)) {
                        if (!isX2ManyCommands(value)) {
                            value = [["clear"], ["link", ...value]];
                        }
                    }
                    receiver.update({ [prop]: value });
                    target.model.triggerEvents("update", { field: prop, value, id: target.id });
                    return true;
                });
            };
        }
        return new Model({
            models,
            records,
            model: models[model],
            traps: { set: setTrapsCache[model] },
            dynamicModels: opts.dynamicModels,
            baseData: baseData[model],
        });
    }

    const create = withoutProxyTrap(_create);
    function _create(
        crud,
        model,
        vals,
        ignoreRelations = false,
        fromSerialized = false,
        delayedSetup = false
    ) {
        if (!("id" in vals)) {
            vals["id"] = uuid(model);
        }

        const record = instantiateModel(model, { models, records: crud.records });

        const id = vals["id"];
        record.id = id;
        if (!vals.uuid && database[model]?.key === "uuid") {
            record.uuid = uuidv4();
            vals.uuid = record.uuid;
        }

        baseData[model][id] = vals;

        crud.records[model].set(id, record);

        const fields = getFields(model);
        for (const name in fields) {
            if (name === "id") {
                continue;
            }

            const field = fields[name];

            if (field.required && !(name in vals)) {
                throw new Error(`'${name}' field is required when creating '${model}' record.`);
            }

            if (RELATION_TYPES.has(field.type)) {
                if (X2MANY_TYPES.has(field.type)) {
                    record[name] = [];
                } else if (field.type === "many2one") {
                    record[name] = undefined;
                }

                if (ignoreRelations) {
                    continue;
                }

                const comodelName = field.relation;
                if (!(name in vals) || !vals[name]) {
                    continue;
                }

                if (X2MANY_TYPES.has(field.type)) {
                    if (fromSerialized) {
                        const ids = vals[name];
                        for (const id of ids) {
                            if (exists(comodelName, id)) {
                                connect(field, record, crud.records[comodelName].get(id));
                            }
                        }
                    } else {
                        for (const [command, ...items] of vals[name]) {
                            if (command === "create") {
                                const newRecords = items.map((_vals) => {
                                    const result = create(crud, comodelName, _vals);
                                    makeRecordsAvailable(
                                        { [comodelName]: [result] },
                                        { [comodelName]: [_vals] }
                                    );
                                    return result;
                                });
                                for (const record2 of newRecords) {
                                    connect(field, record, record2);
                                }
                            } else if (command === "link") {
                                const existingRecords = items.filter((record) =>
                                    exists(comodelName, record.id)
                                );
                                for (const record2 of existingRecords) {
                                    connect(field, record, record2);
                                }
                            }
                        }
                    }
                } else if (field.type === "many2one") {
                    const val = vals[name];
                    if (fromSerialized) {
                        if (exists(comodelName, val)) {
                            connect(field, record, crud.records[comodelName].get(val));
                        }
                    } else {
                        if (val instanceof Base) {
                            if (exists(comodelName, val.id)) {
                                connect(field, record, val);
                            }
                        } else if (models[field.relation] && typeof val === "object") {
                            const newRecord = create(crud, comodelName, val);
                            connect(field, record, newRecord);
                        } else {
                            record[name] = val;
                        }
                    }
                }
            } else {
                record[name] = vals[name];
            }
        }

        // Delayed setup is usefull when using loadData method.
        // Some records must be linked to other records before it can configure itself.
        if (!delayedSetup) {
            record.setup(vals);
        }

        return crud.records[model].get(id);
    }

    function deserialize(crud, model, vals) {
        return create(crud, model, vals, false, true);
    }

    const update = withoutProxyTrap(_update);
    function _update(crud, model, record, vals, opts = {}) {
        const fields = getFields(model);
        Object.assign(baseData[model][record.id], vals);

        for (const name in vals) {
            if (!(name in fields) && name !== "id") {
                continue;
            } else if (name === "id" && vals[name] !== record.id) {
                records[model].delete(record.id);

                for (const key of indexes[model] || []) {
                    const keyVal = record.raw[key];
                    if (Array.isArray(keyVal)) {
                        for (const val of keyVal) {
                            indexedRecords[model][key][val].delete(record.id);
                        }
                    }
                }

                delete baseData[model][record.id];

                record.id = vals[name];
                records[model].set(record.id, record);
                baseData[model][record.id] = vals;
                continue;
            } else if (name === "id") {
                continue;
            }

            const field = fields[name];
            const comodelName = field.relation;
            if (X2MANY_TYPES.has(field.type) && comodelName in models) {
                for (const command of vals[name]) {
                    const [type, ...items] = command;
                    if (type === "unlink") {
                        for (const record2 of items) {
                            disconnect(field, record, record2);
                        }
                    } else if (type === "clear") {
                        const linkedRecs = record[name];
                        for (const record2 of [...linkedRecs]) {
                            disconnect(field, record, record2);
                        }
                    } else if (type === "create") {
                        const newRecords = items.map((vals) => create(crud, comodelName, vals));
                        for (const record2 of newRecords) {
                            connect(field, record, record2);
                        }
                    } else if (type === "link") {
                        const existingRecords = items.filter((record) =>
                            exists(comodelName, record.id)
                        );
                        for (const record2 of existingRecords) {
                            connect(field, record, record2);
                        }
                    } else if (type === "set") {
                        const linkedRecs = record[name];
                        const existingRecords = items.filter((record) =>
                            exists(comodelName, record.id)
                        );
                        for (const record2 of [...linkedRecs]) {
                            disconnect(field, record, record2);
                        }
                        for (const record2 of existingRecords) {
                            connect(field, record, record2);
                        }
                    }

                    baseData[model][record.id][name] = items
                        .filter((r) => typeof r.id === "number")
                        .map((r) => r.id);
                }
            } else if (field.type === "many2one" && comodelName in models) {
                if (vals[name]) {
                    const id = vals[name]?.id || vals[name];
                    const exist = exists(comodelName, id);

                    if (exist) {
                        connect(field, record, vals[name]);
                    } else if (models[field.relation] && typeof vals[name] === "object") {
                        const newRecord = create(crud, comodelName, vals[name]);
                        connect(field, record, newRecord);
                    } else {
                        record[name] = vals[name];
                    }
                } else if (record[name]) {
                    const linkedRec = record[name];
                    disconnect(field, record, linkedRec);
                }
            }

            if (!RELATION_TYPES.has(field.type)) {
                record[name] = vals[name];
            }
        }

        if (typeof record.id === "number" && !opts.silent) {
            commands[model].update.add(record.id);
        }

        record.model.triggerEvents("update", { id: record.id });
    }

    const delete_ = withoutProxyTrap(_delete);
    function _delete(crud, model, record, opts = {}) {
        const id = record.id;
        const fields = getFields(model);
        const handleCommand = (inverse, field, record, backend = false) => {
            if (inverse && !inverse.dummy && !opts.silent && typeof id === "number") {
                const modelCommands = commands[field.relation];
                const map = backend ? modelCommands.delete : modelCommands.unlink;
                const oldVal = map.get(inverse.name);
                map.set(inverse.name, [...(oldVal || []), record.id]);
            }
        };

        for (const name in fields) {
            const field = fields[name];
            const inverse = inverseMap.get(field);

            if (X2MANY_TYPES.has(field.type)) {
                for (const record2 of [...record[name]]) {
                    handleCommand(inverse, field, record, opts.backend);
                    disconnect(field, record, record2);
                }
            } else if (field.type === "many2one" && typeof record[name] === "object") {
                handleCommand(inverse, field, record, opts.backend);
                disconnect(field, record, record[name]);
            }
        }

        const key = database[model]?.key || "id";
        models[model].triggerEvents("delete", { key: record[key] });
        crud.records[model].delete(id);
        for (const key of indexes[model] || []) {
            const keyVal = record.raw[key];
            if (Array.isArray(keyVal)) {
                for (const val of keyVal) {
                    crud.indexedRecords[model][key][val].delete(record.id);
                }
            } else {
                delete crud.indexedRecords[model][key][keyVal];
            }
        }

        return id;
    }

    function createCRUD(model, fields) {
        return {
            // We need to read these object from `this` to keep
            // the reactivity. Otherwise, we read the fields on
            // reactive with no callback.
            get records() {
                return records;
            },
            get orderedRecords() {
                return Array.from(this.records[model].values());
            },
            get indexedRecords() {
                return indexedRecords;
            },
            get indexes() {
                return indexes;
            },
            get modelName() {
                return model;
            },
            get modelFields() {
                return getFields(this.modelName);
            },
            create(vals, ignoreRelations = false, fromSerialized = false, delayedSetup = false) {
                const record = create(
                    this,
                    model,
                    vals,
                    ignoreRelations,
                    fromSerialized,
                    delayedSetup
                );
                makeRecordsAvailable({ [model]: [record] }, { [model]: [vals] });
                return record;
            },
            deserialize(vals) {
                return deserialize(this, model, vals);
            },
            createMany(valsList) {
                const result = [];
                for (const vals of valsList) {
                    result.push(create(this, model, vals));
                }
                return result;
            },
            update(record, vals, opts = {}) {
                return update(this, model, record, vals, opts);
            },
            delete(record, opts = {}) {
                return delete_(this, model, record, opts);
            },
            deleteMany(toDelete, opts = {}) {
                const result = [];
                let mustBreak = 0;
                while (toDelete.length) {
                    result.push(delete_(this, model, toDelete[toDelete.length - 1], opts));
                    mustBreak += 1;

                    if (mustBreak > 1000) {
                        console.warn("Too many records to delete. Breaking the loop.");
                        break;
                    }
                }
                return result;
            },
            read(value) {
                const id = /^\d+$/.test(value) ? parseInt(value) : value; // In case of ID came from an input
                if (!this.records[model].has(id)) {
                    return;
                }
                return this.records[model].get(id);
            },
            readFirst() {
                if (!(model in this.records)) {
                    return;
                }
                return this.orderedRecords[0];
            },
            readBy(key, val) {
                if (!indexes[model].includes(key)) {
                    throw new Error(`Unable to get record by '${key}'`);
                }
                const result = this.indexedRecords[model][key][val];
                if (result instanceof Map) {
                    return Array.from(result.values());
                }
                return result;
            },
            readAll() {
                return this.orderedRecords;
            },
            readAllBy(key) {
                if (!this.indexes[model].includes(key)) {
                    throw new Error(`Unable to get record by '${key}'`);
                }
                const record = this.indexedRecords[model][key];
                if (record[Object.keys(record)[0]] instanceof Map) {
                    return Object.fromEntries(
                        Object.entries(record).map(([key, value]) => [
                            key,
                            Array.from(value.values()),
                        ])
                    );
                }
                return record;
            },
            readMany(ids) {
                if (!(model in this.records)) {
                    return [];
                }
                return ids.map((value) => this.read(value));
            },
            /**
             * @param {object} options
             * @param {boolean} options.orm - Exclude local & related fields from the serialization
             */
            serialize(record, options = {}) {
                const orm = options.orm ?? false;
                const result = {};
                for (const name in fields) {
                    const field = fields[name];
                    if ((orm && field.local) || (orm && field.related) || (orm && field.compute)) {
                        continue;
                    }

                    if (field.type === "many2one") {
                        result[name] = record[name]?.id || record.raw[name] || false;
                    } else if (X2MANY_TYPES.has(field.type)) {
                        const ids = [...record[name]].map((record) => record.id).filter(Boolean);
                        result[name] = ids.length ? ids : (!orm && record.raw[name]) || [];
                    } else if (typeof record[name] === "object") {
                        result[name] = JSON.stringify(record[name]);
                    } else {
                        result[name] = record[name] !== undefined ? record[name] : false;
                    }
                }
                return result;
            },
            // aliases
            getAllBy() {
                return this.readAllBy(...arguments);
            },
            getAll() {
                return this.readAll(...arguments);
            },
            getBy() {
                return this.readBy(...arguments);
            },
            get() {
                return this.read(...arguments);
            },
            getFirst() {
                return this.readFirst(...arguments);
            },
            // array prototype
            map(fn) {
                return this.orderedRecords.map(fn);
            },
            reduce(fn, initialValue) {
                return this.orderedRecords.reduce(fn, initialValue);
            },
            flatMap(fn) {
                return this.orderedRecords.flatMap(fn);
            },
            forEach(fn) {
                return this.orderedRecords.forEach(fn);
            },
            some(fn) {
                return this.orderedRecords.some(fn);
            },
            every(fn) {
                return this.orderedRecords.every(fn);
            },
            find(fn) {
                return this.orderedRecords.find(fn);
            },
            filter(fn) {
                return this.orderedRecords.filter(fn);
            },
            sort(fn) {
                return this.orderedRecords.sort(fn);
            },
            indexOf(record) {
                return this.orderedRecords.indexOf(record);
            },
            get length() {
                return this.records[model].size;
            },
            // External callbacks
            addEventListener(event, callback) {
                if (!AVAILABLE_EVENT.includes(event)) {
                    throw new Error(`Event '${event}' is not available`);
                }

                if (!(event in callbacks[model])) {
                    callbacks[model][event] = [];
                }

                callbacks[model][event].push(callback);
            },
            triggerEvents(event, data) {
                if (!(event in callbacks[model]) || callbacks[model][event].length === 0 || !data) {
                    return;
                }

                for (const callback of callbacks[model][event]) {
                    callback(data);
                }
            },
        };
    }

    const models = mapObj(processedModelDefs, (model, fields) => createCRUD(model, fields));

    /**
     * Load the data without the relations then link the related records.
     * @param {*} rawData
     */
    const loadData = withoutProxyTrap(_loadData);
    function _loadData(models, rawData, load = [], fromSerialized = false) {
        const results = {};
        const oldStates = {};
        const ignoreConnection = {};

        for (const model in rawData) {
            ignoreConnection[model] = [];
            const modelKey = database[model]?.key || "id";
            if (!oldStates[model]) {
                oldStates[model] = {};
            }

            if (!load.includes(model) && load.length !== 0) {
                continue;
            } else if (!results[model]) {
                results[model] = [];
            }

            const _records = rawData[model];
            for (const record of _records) {
                if (fromSerialized && typeof record.id === "string") {
                    const data = record.id.split("_");
                    const id = parseInt(data[1]);
                    const model = data[0];

                    if (id >= ID_CONTAINER[model] || !ID_CONTAINER[model]) {
                        ID_CONTAINER[model] = id + 1;
                    }
                }

                const oldRecord = models[model].indexedRecords[model][modelKey][record[modelKey]];
                if (oldRecord) {
                    oldStates[model][oldRecord[modelKey]] = oldRecord.serializeState();
                    for (const [f, p] of Object.entries(modelClasses[model]?.extraFields || {})) {
                        if (X2MANY_TYPES.has(p.type)) {
                            record[f] = oldRecord[f]?.map((r) => r.id) || [];
                            continue;
                        }
                        record[f] = oldRecord[f]?.id || false;
                    }
                }

                if (oldRecord) {
                    const raw = {};
                    for (const [field, value] of Object.entries(record)) {
                        const params = getFields(model)[field];
                        if (field === "id" || !params) {
                            continue;
                        }

                        if (X2MANY_TYPES.has(params.type)) {
                            value.push(
                                ...oldRecord[field]
                                    .filter((r) => typeof r.id === "string")
                                    .map((r) => r.id)
                            );
                            const existingRecords = value
                                .map((r) => models[params.relation]?.get(r))
                                .filter(Boolean);
                            if (existingRecords.length) {
                                record[field] = [["set", ...existingRecords]];
                            } else {
                                record[field] = [];
                            }
                            raw[field] = value.filter((id) => typeof id === "number");
                        } else if (
                            params.type === "many2one" &&
                            value &&
                            !exists(params.relation, value)
                        ) {
                            const key = `${params.relation}_${value}`;
                            if (!missingFields[key]) {
                                missingFields[key] = [[oldRecord, params]];
                            } else {
                                missingFields[key].push([oldRecord, params]);
                            }
                        }
                    }

                    oldRecord.update(record, { silent: true });
                    oldRecord.setup(record);
                    ignoreConnection[model].push(record.id);
                    results[model].push(oldRecord);
                    Object.assign(baseData[model][record.id], raw);
                    continue;
                }

                const result = create(models[model], model, record, true, false, true);
                if (oldRecord && oldRecord.id !== result.id) {
                    oldRecord.delete();
                }

                if (!(model in results)) {
                    results[model] = [];
                }

                results[model].push(result);
            }
        }

        const alreadyLinkedSet = new Set();
        const modelToSetup = [];

        // link the related records
        for (const model in rawData) {
            if (alreadyLinkedSet.has(model) || (!load.includes(model) && load.length !== 0)) {
                continue;
            }

            const rawRecords = rawData[model];
            const fields = getFields(model);

            for (const rawRec of rawRecords) {
                const recorded = records[model].get(rawRec.id);

                // Check if there are any missing fields for this record
                const key = `${model}_${rawRec.id}`;
                if (missingFields[key]) {
                    for (const [record, field] of missingFields[key]) {
                        // Connect the `recorded` to the missing `field` in `record`
                        connect(field, record, recorded);
                    }
                    delete missingFields[key];
                }

                if (ignoreConnection[model].includes(rawRec.id)) {
                    continue;
                }

                for (const name in fields) {
                    const field = fields[name];
                    alreadyLinkedSet.add(field);

                    if (X2MANY_TYPES.has(field.type)) {
                        if (name in rawRec) {
                            for (const id of rawRec[name]) {
                                if (field.relation in records) {
                                    const toConnect = records[field.relation].get(id);
                                    if (toConnect) {
                                        connect(field, recorded, toConnect);
                                    } else {
                                        const key = `${field.relation}_${id}`;
                                        if (!missingFields[key]) {
                                            missingFields[key] = [[recorded, field]];
                                        } else {
                                            missingFields[key].push([recorded, field]);
                                        }
                                    }
                                }
                            }
                        }
                    } else if (field.type === "many2one" && rawRec[name]) {
                        if (field.relation in records) {
                            const id = rawRec[name];
                            const toConnect = records[field.relation].get(id);
                            if (toConnect) {
                                connect(field, recorded, toConnect);
                            } else {
                                const key = `${field.relation}_${id}`;
                                if (!missingFields[key]) {
                                    missingFields[key] = [[recorded, field]];
                                } else {
                                    missingFields[key].push([recorded, field]);
                                }
                            }
                        }
                    }
                }

                modelToSetup.push({ raw: rawRec, record: recorded });
            }
        }

        // Setup all records when relations are linked
        for (const { raw, record } of modelToSetup) {
            record.setup(raw);
            const model = record.model.modelName;
            const modelKey = database[model]?.key || "id";
            const states = oldStates[model][record[modelKey]];
            if (states) {
                record.setupState(states);
            }
        }

        makeRecordsAvailable(results, rawData);
        return results;
    }

    const makeRecordsAvailable = withoutProxyTrap(_makeRecordsAvailable);
    function _makeRecordsAvailable(results, rawData) {
        const indexRecord = (model, records) => {
            for (const key of indexes[model] || []) {
                for (const record of records) {
                    const keyVal = record[key];

                    if (!keyVal) {
                        continue;
                    }

                    if (Array.isArray(keyVal)) {
                        for (const keyV of keyVal) {
                            if (!indexedRecords[model][key][keyV.id]) {
                                indexedRecords[model][key][keyV.id] = new Map();
                            }
                            indexedRecords[model][key][keyV.id].set(record.id, record);
                        }
                    } else {
                        indexedRecords[model][key][keyVal] = record;
                    }
                }
            }
        };

        for (const [model, values] of Object.entries(results)) {
            indexRecord(model, values);
            models[model].triggerEvents("create", {
                ids: values.map((v) => v.id),
                model: model,
            });
        }
    }

    models.loadData = loadData;
    models.commands = commands;

    return { models, records, indexedRecords, baseData };
}
