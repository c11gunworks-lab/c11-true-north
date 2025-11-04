/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from "fs";
import * as path from "path";

import { DependencyContainer } from "tsyringe";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { IDatabaseTables } from "@spt/models/spt/server/IDatabaseTables";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { ITemplateItem, ISlot, ItemType } from "@spt/models/eft/common/tables/ITemplateItem";
import { JsonUtil } from "@spt/utils/JsonUtil";
import { PreSptModLoader } from "@spt/loaders/PreSptModLoader";
import { RecursiveCloner } from "@spt/utils/cloners/RecursiveCloner";

import itemTemplate from "../templates/item_template.json";

const modConfig = {
    lvl1Traders: true,
    oldLocales: false
};

interface ILocale 
{
    Name: string; ShortName?: string; Description: string; 
}

interface IItem 
{
    enable: boolean;
    clone?: string;
    enableCloneCompats?: boolean;
    enableCloneConflicts?: boolean;
    item?: ITemplateItem;
    handbook?: { ParentId: string; Price: number; };
    locales?: Record<string, ILocale>;
    presets?: Record<string, string>;
    addToThisItemsFilters?: any;
    addToExistingItemFilters?: any;
}

interface IPack 
{
    name: string;
    items?: Record<string, IItem>;
    globals?: any;
    filters?: PackFilters;
}

interface PackFilters 
{
    push?: Array<
    | { type: "slotAllowTpl"; baseTpl: string; slot: string; tpl: string }
    | { type: "slotAllowCategory"; slot: string; categoryTpl: string }
    | { type: "ammoAllowTpl"; baseTpl: string; tpl: string }
    >;
    removeExclusions?: string[];
}

interface IConfig 
{
    packs?: Record<string, boolean>;
    traders?: { enabled?: boolean; ids?: string[] };
}

/** Local view of filter[0] used in Slots/Chambers/Cartridges */
type Filter0 = { Filter?: string[]; ExcludedFilter?: string[] };

class Truenorth implements IPostDBLoadMod 
{
    private cloner: RecursiveCloner;
    private db: IDatabaseTables;
    private logger: ILogger;
    private jsonUtil: JsonUtil;

    // used as a "current pack" context so your existing methods work unchanged
    private mydb: {
        modItems?: Record<string, IItem>;
        globals?: any;
        traders?: Record<string, { assort: any }>;
    } = {};

    private tradersSingleton: Record<string, { assort: any }> = {};
    private colorizeRedWhite(input: string, startWithRed = true): string 
    {
        const RED = "\x1b[31m";
        const WHITE = "\x1b[37m";
        const RESET = "\x1b[0m";
        let useRed = startWithRed;
        let out = "";
    
        for (const ch of input) 
        {
            if (/[A-Za-z]/.test(ch)) 
            {
                out += (useRed ? RED : WHITE) + ch + RESET;
                useRed = !useRed;
            }
            else 
            {
                out += ch;
            }
        }
        return out + RESET;
    }
    
    public postDBLoad(container: DependencyContainer): void 
    {
        this.logger = container.resolve<ILogger>("WinstonLogger");
        this.jsonUtil = container.resolve<JsonUtil>("JsonUtil");
        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        const modLoader = container.resolve<PreSptModLoader>("PreSptModLoader");
        this.cloner = container.resolve<RecursiveCloner>("RecursiveCloner");
        this.db = databaseServer.getTables();

        const modFullName = "C11-TrueNorth";
        const modPath = modLoader.getModPath(modFullName);
        // 1) After computing modPath:
        const rootGlobalsPath = path.join(modPath, "database", "globals.json");
        let rootGlobals: any = undefined;
        if (fs.existsSync(rootGlobalsPath)) 
        {
            try 
            {
                rootGlobals = JSON.parse(fs.readFileSync(rootGlobalsPath, "utf-8"));
                this.logger.info("Loaded root database/globals.json");
            }
            catch (e) 
            {
                this.logger.warning(`Failed parsing root globals.json: ${(e as Error).message}`);
            }
        }

        // 2) After finishing per-pack processing (right before or after traders section), merge root globals:
        if (rootGlobals?.ItemPresets) 
        {
            for (const preset in rootGlobals.ItemPresets) 
            {
                this.db.globals.ItemPresets[preset] = rootGlobals.ItemPresets[preset];
            }
            this.logger.info("Merged root ItemPresets into db.globals.ItemPresets");
        }

        this.logger.info(
            this.colorizeRedWhite("Welcome to the Frozen End of the Earth: The True North", true)
        );
        

        // 1) Load config (defaults if missing)
        const cfg = this.loadConfig(modPath);

        // 2) Load packs enabled by config
        const packsDir = path.join(modPath, "database", "packs");
        const packs = this.loadPacks(packsDir, cfg);

        // 3) Process each pack (items/locales/per-item pushes/presets/pack filters)
        for (const p of packs) 
        {
            this.processPack(p);
        }

        // 4) Traders: one assort per trader (read once, apply once)
        if (cfg.traders?.enabled !== false) 
        {
            const tradersDir = path.join(modPath, "database", "traders");
            const traderIds = cfg.traders?.ids;
            this.tradersSingleton = this.loadTradersSingleton(tradersDir, traderIds);

            if (Object.keys(this.tradersSingleton).length > 0) 
            {
                // point mydb.traders to the singleton so your existing addTraderAssort works as-is
                this.mydb.traders = this.tradersSingleton;
                for (const traderId of Object.keys(this.tradersSingleton)) 
                {
                    this.addTraderAssort(traderId);
                }
                this.logger.debug("Traders: single assorts applied");
            }
            else 
            {
                this.logger.debug("Traders: no assorts found to apply");
            }
        }
        else 
        {
            this.logger.debug("Traders: disabled by config");
        }

        this.logger.debug("All packs processed");
    }

    // -------------------- Loaders --------------------

    private loadConfig(modPath: string): IConfig 
    {
        const p = path.join(modPath, "config.json");
        if (!fs.existsSync(p)) return { packs: {}, traders: { enabled: true } };
        try 
        {
            const cfg = JSON.parse(fs.readFileSync(p, "utf-8")) as IConfig;
            cfg.traders ??= { enabled: true };
            cfg.packs ??= {};
            return cfg;
        }
        catch (e) 
        {
            this.logger.warning(`config.json parse error, using defaults: ${(e as Error).message}`);
            return { packs: {}, traders: { enabled: true } };
        }
    }

    private loadPacks(packsDir: string, cfg: IConfig): IPack[] 
    {
        if (!fs.existsSync(packsDir)) return [];
        const names = fs.readdirSync(packsDir).filter(f => fs.statSync(path.join(packsDir, f)).isDirectory());
        const out: IPack[] = [];

        for (const name of names) 
        {
            // default: enabled unless explicitly disabled in config
            const enabled = Object.prototype.hasOwnProperty.call(cfg.packs ?? {}, name)
                ? !!(cfg.packs as Record<string, boolean>)[name]
                : true;
            if (!enabled) continue;

            const root = path.join(packsDir, name);
            const itemsPath = path.join(root, "items.json");
            if (!fs.existsSync(itemsPath)) continue;

            const pack: IPack = {
                name,
                items: JSON.parse(fs.readFileSync(itemsPath, "utf-8"))
            };

            const globalsPath = path.join(root, "globals.json");
            if (fs.existsSync(globalsPath)) pack.globals = JSON.parse(fs.readFileSync(globalsPath, "utf-8"));

            const filtersPath = path.join(root, "filters.json");
            if (fs.existsSync(filtersPath)) pack.filters = JSON.parse(fs.readFileSync(filtersPath, "utf-8"));

            out.push(pack);
        }
        return out;
    }

    private loadTradersSingleton(tradersDir: string, ids?: string[]): Record<string, { assort: any }> 
    {
        const result: Record<string, { assort: any }> = {};
        if (!fs.existsSync(tradersDir)) return result;

        if (ids?.length) 
        {
            for (const id of ids) 
            {
                const assortPath = path.join(tradersDir, id, "assort.json");
                if (!fs.existsSync(assortPath)) 
                {
                    this.logger.warning(`Trader ${id} missing assort.json under ${assortPath}`);
                    continue;
                }
                try 
                {
                    result[id] = { assort: JSON.parse(fs.readFileSync(assortPath, "utf-8")) };
                }
                catch (e) 
                {
                    this.logger.warning(`Failed reading trader ${id} assort.json: ${(e as Error).message}`);
                }
            }
            return result;
        }

        // autodiscover if no ids provided
        const traderIds = fs.readdirSync(tradersDir).filter(d => fs.statSync(path.join(tradersDir, d)).isDirectory());
        for (const id of traderIds) 
        {
            const assortPath = path.join(tradersDir, id, "assort.json");
            if (fs.existsSync(assortPath)) 
            {
                try 
                {
                    result[id] = { assort: JSON.parse(fs.readFileSync(assortPath, "utf-8")) };
                }
                catch (e) 
                {
                    this.logger.warning(`Failed reading trader ${id} assort.json: ${(e as Error).message}`);
                }
            }
        }
        return result;
    }

    // -------------------- Per-pack processing --------------------

    private processPack(pack: IPack): void 
    {
        this.logger.debug(`Processing pack: ${pack.name}`);

        // Make pack available to existing methods
        this.mydb = { modItems: pack.items ?? {}, globals: pack.globals };

        // Items: clone/create + handbook + locales
        if (this.mydb.modItems && Object.keys(this.mydb.modItems).length > 0) 
        {
            for (const [tpl, entry] of Object.entries<IItem>(this.mydb.modItems)) 
            {
                if (!entry.enable) continue;

                if ("clone" in entry && entry.clone) 
                {
                    this.cloneItem(entry.clone, tpl);
                    // copy source compat to clone if enabled (default true)
                    const allowComp = entry.enableCloneCompats !== false;
                    const allowConf = entry.enableCloneConflicts !== false;
                    this.copyToFilters(entry.clone, tpl, allowComp, allowConf);
                }
                else 
                {
                    this.createItem(tpl);
                }

                this.addLocales(tpl, entry);
            }

            // Per‑item compat pushes
            for (const tpl of Object.keys(this.mydb.modItems)) 
            {
                if (this.mydb.modItems[tpl].enable) this.addToFilters(tpl);
            }
            this.logger.debug(`${pack.name}: items + per-item filters done`);
        }

        // Globals (presets, etc.)
        if (this.mydb.globals?.ItemPresets) 
        {
            for (const preset in this.mydb.globals.ItemPresets) 
            {
                this.db.globals.ItemPresets[preset] = this.mydb.globals.ItemPresets[preset];
            }
            this.logger.debug(`${pack.name}: presets merged`);
        }

        // Pack‑wide filter pushes
        if (pack.filters) 
        {
            this.applyPackWideFilters(pack.filters);
            this.logger.debug(`${pack.name}: pack-wide filters applied`);
        }
    }

    // -------------------- Filter helpers --------------------

    private applyPackWideFilters(cfg: PackFilters): void 
    {
        for (const step of (cfg.push ?? [])) 
        {
            switch (step.type) 
            {
                case "slotAllowTpl":
                    this.addToSlotFilter(step.baseTpl, step.slot, step.tpl);
                    break;
                case "slotAllowCategory":
                    this.bulkAllowCategory(step.slot, step.categoryTpl);
                    break;
                case "ammoAllowTpl":
                    this.addToCartridgesFilter(step.baseTpl, step.tpl);
                    this.addToChambersFilter(step.baseTpl, step.tpl);
                    break;
            }
        }
        for (const tpl of (cfg.removeExclusions ?? [])) 
        {
            this.removeFromExcludedEverywhere(tpl);
        }
    }

    private addToSlotFilter(baseTpl: string, slotName: string, tplToAdd: string): void 
    {
        const base = this.db.templates.items[baseTpl];
        const slot = base?._props?.Slots?.find(s => s._name === slotName);
        const f0 = slot?._props?.filters?.[0] as unknown as Filter0;
        if (!f0?.Filter) return;

        this.ensureArrayUniquePush(f0.Filter, tplToAdd);
        f0.ExcludedFilter ??= [];
        this.removeFromArray(f0.ExcludedFilter, tplToAdd);
    }

    private bulkAllowCategory(slotName: string, categoryTpl: string): void 
    {
        for (const it of Object.values(this.db.templates.items)) 
        {
            const slot = it?._props?.Slots?.find(s => s._name === slotName);
            const f0 = slot?._props?.filters?.[0] as unknown as Filter0;
            if (!f0?.Filter) continue;
            this.ensureArrayUniquePush(f0.Filter, categoryTpl);
        }
    }

    private addToCartridgesFilter(baseTpl: string, ammoTpl: string): void 
    {
        const cartProps = this.db.templates.items[baseTpl]?._props?.Cartridges?.[0]?._props;
        const f0 = cartProps?.filters?.[0] as unknown as Filter0;
        if (!f0?.Filter) return;

        this.ensureArrayUniquePush(f0.Filter, ammoTpl);
        f0.ExcludedFilter ??= [];
        this.removeFromArray(f0.ExcludedFilter, ammoTpl);
    }

    private addToChambersFilter(baseTpl: string, ammoTpl: string): void 
    {
        const chambers = this.db.templates.items[baseTpl]?._props?.Chambers;
        if (!Array.isArray(chambers)) return;

        for (const ch of chambers) 
        {
            const f0 = ch?._props?.filters?.[0] as unknown as Filter0;
            if (!f0?.Filter) continue;

            this.ensureArrayUniquePush(f0.Filter, ammoTpl);
            f0.ExcludedFilter ??= [];
            this.removeFromArray(f0.ExcludedFilter, ammoTpl);
        }
    }

    private removeFromExcludedEverywhere(tpl: string): void 
    {
        for (const it of Object.values(this.db.templates.items)) 
        {
            // Slots
            for (const s of (it?._props?.Slots ?? [])) 
            {
                const f0 = s?._props?.filters?.[0] as unknown as Filter0;
                if (f0?.ExcludedFilter) this.removeFromArray(f0.ExcludedFilter, tpl);
            }
            // Chambers
            for (const ch of (it?._props?.Chambers ?? [])) 
            {
                const f0 = ch?._props?.filters?.[0] as unknown as Filter0;
                if (f0?.ExcludedFilter) this.removeFromArray(f0.ExcludedFilter, tpl);
            }
            // Cartridges
            for (const ca of (it?._props?.Cartridges ?? [])) 
            {
                const f0 = ca?._props?.filters?.[0] as unknown as Filter0;
                if (f0?.ExcludedFilter) this.removeFromArray(f0.ExcludedFilter, tpl);
            }
            // ConflictingItems
            const ci = it?._props?.ConflictingItems;
            if (Array.isArray(ci)) this.removeFromArray(ci, tpl);
        }
    }

    private ensureArrayUniquePush<T>(arr: T[], val: T): void 
    {
        if (!arr.includes(val)) arr.push(val);
    }
    private removeFromArray<T>(arr: T[], val: T): void 
    {
        const i = arr.indexOf(val);
        if (i !== -1) arr.splice(i, 1);
    }

    // -------------------- Your existing item methods (fixed where needed) --------------------

    // eslint-disable-next-line @typescript-eslint/naming-convention
    private cloneItem(itemToClone: string, ID: string): void 
    {
        if (this.mydb.modItems?.[ID]?.enable !== true) return;

        const originalItem = this.db.templates.items[itemToClone];
        if (!originalItem) 
        {
            this.logger.error(
                `[${ID}] ERROR: Could not clone item. The item to be cloned, "${itemToClone}", does not exist in the database. Please check your items.json.`
            );
            return;
        }

        const itemOut = this.jsonUtil.clone(originalItem) as ITemplateItem;
        itemOut._id = ID;

        const changes = this.mydb.modItems?.[ID]?.item;
        if (changes) this.compareAndReplace(itemOut as any, changes as any);

        this.db.templates.items[ID] = itemOut;

        const handbookEntry = {
            Id: ID,
            ParentId: this.mydb.modItems?.[ID]?.handbook?.ParentId ?? "",
            Price: this.mydb.modItems?.[ID]?.handbook?.Price ?? 0
        };
        this.db.templates.handbook.Items.push(handbookEntry);
        this.logger.debug(`item ${ID} added to handbook with price ${handbookEntry.Price}`);
    }

    private createItem(itemToCreate: string): void 
    {
        const newItem = this.mydb.modItems?.[itemToCreate];
        if (!newItem?.enable) return;

        const [pass, checkedItem] = this.checkItem(newItem);
        if (!pass) return;

        this.db.templates.items[itemToCreate] = checkedItem;
        this.logger.debug(`Item ${itemToCreate} created and added to database`);

        const handbookEntry = {
            Id: itemToCreate,
            ParentId: newItem.handbook?.ParentId ?? "",
            Price: newItem.handbook?.Price ?? 0
        };
        this.db.templates.handbook.Items.push(handbookEntry);
        this.logger.debug(`Item ${itemToCreate} added to handbook with price ${handbookEntry.Price}`);
    }

    private checkItem(itemToCheck: IItem): [boolean, ITemplateItem] 
    {
        let pass = true;

        // required top-level keys from template
        for (const level1 in itemTemplate) 
        {
            if (!(level1 in (itemToCheck.item as any))) 
            {
                this.logger.error(`ERROR - Missing attribute: "${level1}" in your item entry!`);
                pass = false;
            }
        }

        // warn on extra props not in template
        for (const prop in (itemToCheck.item as any)._props) 
        {
            if (!(prop in (itemTemplate as any)._props)) 
            {
                this.logger.warning(`WARNING - Attribute: "${prop}" not found in item template!`);
            }
        }

        const itemOUT: ITemplateItem = {
            _id: (itemToCheck.item as ITemplateItem)._id,
            _name: (itemToCheck.item as ITemplateItem)._name,
            _parent: (itemToCheck.item as ITemplateItem)._parent,
            _props: (itemToCheck.item as ITemplateItem)._props,
            _type: (itemToCheck.item as ITemplateItem)._type as ItemType,
            _proto: (itemToCheck.item as ITemplateItem)._proto
        };
        return [pass, itemOUT];
    }

    private compareAndReplace(originalItem: any, attributesToChange: any): any 
    {
        if (!attributesToChange || typeof attributesToChange !== "object") return originalItem;

        for (const key in attributesToChange) 
        {
            const val = attributesToChange[key];
            const isPrim = ["boolean", "string", "number"].includes(typeof val);
            const isArr = Array.isArray(val);

            if (isPrim || isArr) 
            {
                if (key in originalItem) 
                {
                    originalItem[key] = val;
                }
                else 
                {
                    this.logger.warning(`(Item: ${originalItem._id}) WARNING: Could not find the attribute: "${key}" in the original item, adding new key`);
                    originalItem[key] = val;
                }
            }
            else 
            {
                originalItem[key] = this.compareAndReplace(originalItem[key] ?? {}, val);
            }
        }
        return originalItem;
    }

    private getFilters(item: string): [Array<ISlot>, Array<string>] 
    {
        const base = this.db.templates.items[item];
        const slots = Array.isArray(base?._props?.Slots) ? base._props.Slots : [];
        const chambers = Array.isArray(base?._props?.Chambers) ? base._props.Chambers : [];
        const cartridges = Array.isArray(base?._props?.Cartridges) ? base._props.Cartridges : [];
        const filters = (slots as ISlot[]).concat(chambers as unknown as ISlot[], cartridges as unknown as ISlot[]);
        const conflictingItems = Array.isArray(base?._props?.ConflictingItems) ? base._props.ConflictingItems : [];
        return [filters, conflictingItems];
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    private copyToFilters(itemClone: string, ID: string, enableCompats = true, enableConflicts = true): void 
    {
    // For each item in the DB (excluding items we just created in this pack),
    // if they allow or conflict with the source tpl, add our clone too.
        for (const item in this.db.templates.items) 
        {
            if (Object.prototype.hasOwnProperty.call(this.mydb.modItems ?? {}, item)) continue;

            const [filters, conflictingItems] = this.getFilters(item);

            if (enableCompats) 
            {
                for (const filter of filters) 
                {
                    const f0 = (filter?._props?.filters?.[0] as unknown) as Filter0;
                    if (!f0?.Filter) continue;
                    if (f0.Filter.includes(itemClone)) this.ensureArrayUniquePush(f0.Filter, ID);
                }
            }

            if (enableConflicts) 
            {
                if (Array.isArray(conflictingItems) && conflictingItems.includes(itemClone)) 
                {
                    this.ensureArrayUniquePush(conflictingItems, ID);
                }
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    private addToFilters(ID: string): void
    {
        const id = ID?.trim();
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const NewItem = this.mydb.modItems?.[id];
        if (!NewItem?.enable) return;

        this.logger.debug(`addToFilters: ${id}`);

        // -----------------------------
        // 1) Add to THIS item's slots
        // -----------------------------
        if (NewItem.addToThisItemsFilters)
        {
            const [itemFilters, conflictingItems] = this.getFilters(id);

            // Conflicts on this item
            if (Array.isArray(NewItem.addToThisItemsFilters.conflicts))
            {
                for (const raw of NewItem.addToThisItemsFilters.conflicts)
                {
                    const c = typeof raw === "string" ? raw.trim() : raw;
                    if (c) this.ensureArrayUniquePush(conflictingItems, c);
                }
            }

            // Slot allows on this item
            for (const rawSlotName in NewItem.addToThisItemsFilters)
            {
                if (rawSlotName === "conflicts") continue;

                const slotName = rawSlotName.trim();
                const allowList = NewItem.addToThisItemsFilters[slotName];
                if (!Array.isArray(allowList)) continue;

                const slot = itemFilters.find(s => s?._name === slotName);
                if (!slot)
                {
                    const available = itemFilters.map(s => s?._name).filter(Boolean);
                    this.logger.warning(
                        `[addToThisItemsFilters] Slot "${slotName}" not found on ${id}. ` +
                    `Available slots: ${available.join(", ")}`
                    );
                    continue;
                }

                // Ensure _props.filters[0].Filter exists
                const slotAny = slot as any;
                slotAny._props ??= {};
                slotAny._props.filters ??= [{}];
                const f0 = slotAny._props.filters[0] as Filter0;
                f0.Filter ??= [];

                for (const raw of allowList)
                {
                    const tpl = typeof raw === "string" ? raw.trim() : raw;
                    if (tpl) this.ensureArrayUniquePush(f0.Filter, tpl);
                }
            }
        }

        // -------------------------------------------
        // 2) Add THIS item into OTHER items' slots
        // -------------------------------------------
        if (NewItem.addToExistingItemFilters)
        {
        // Conflicts: push THIS id into others' ConflictingItems
            if (Array.isArray(NewItem.addToExistingItemFilters.conflicts))
            {
                for (const raw of NewItem.addToExistingItemFilters.conflicts)
                {
                    const conflictingItemTpl = typeof raw === "string" ? raw.trim() : raw;
                    if (!conflictingItemTpl) continue;
                    const [, conflictingItems] = this.getFilters(conflictingItemTpl);
                    this.ensureArrayUniquePush(conflictingItems, id);
                }
            }

            // For each slot definition
            for (const rawSlotName in NewItem.addToExistingItemFilters)
            {
                if (rawSlotName === "conflicts") continue;

                const slotName = rawSlotName.trim();
                const value = NewItem.addToExistingItemFilters[slotName];

                // Shape A: array of "compatible items" whose slot should accept THIS id
                if (Array.isArray(value))
                {
                    for (const raw of value)
                    {
                        const compatibleItemTpl = typeof raw === "string" ? raw.trim() : raw;
                        if (!compatibleItemTpl) continue;

                        const [filters] = this.getFilters(compatibleItemTpl);

                        let matchedAny = false;
                        for (const filter of filters)
                        {
                            if (filter?._name !== slotName) continue;

                            const fAny = filter as any;
                            fAny._props ??= {};
                            fAny._props.filters ??= [{}];
                            const f0 = fAny._props.filters[0] as Filter0;
                            f0.Filter ??= [];
                            this.ensureArrayUniquePush(f0.Filter, id);
                            matchedAny = true;
                        }

                        if (!matchedAny)
                        {
                            const available = filters.map(f => f?._name).filter(Boolean);
                            this.logger.warning(
                                `[addToExistingItemFilters] Slot "${slotName}" not found on ${compatibleItemTpl}. ` +
                            `Available slots: ${available.join(", ")}`
                            );
                        }
                    }
                    continue;
                }

                // Shape B: per‑item map → { [compatibleItemTpl]: string[] of explicit ids to add }
                if (value && typeof value === "object")
                {
                    for (const k in value)
                    {
                        const compatibleItemTpl = k.trim();
                        const idsToAddRaw = value[k];
                        const idsToAdd = Array.isArray(idsToAddRaw) && idsToAddRaw.length > 0
                            ? idsToAddRaw
                            : [id];

                        const [filters] = this.getFilters(compatibleItemTpl);

                        let matchedAny = false;
                        for (const filter of filters)
                        {
                            if (filter?._name !== slotName) continue;

                            const fAny = filter as any;
                            fAny._props ??= {};
                            fAny._props.filters ??= [{}];
                            const f0 = fAny._props.filters[0] as Filter0;
                            f0.Filter ??= [];

                            for (const raw of idsToAdd)
                            {
                                const tpl = typeof raw === "string" ? raw.trim() : raw;
                                if (tpl) this.ensureArrayUniquePush(f0.Filter, tpl);
                            }
                            matchedAny = true;
                        }

                        if (!matchedAny)
                        {
                            const available = filters.map(f => f?._name).filter(Boolean);
                            this.logger.warning(
                                `[addToExistingItemFilters] Slot "${slotName}" not found on ${compatibleItemTpl}. ` +
                            `Available slots: ${available.join(", ")}`
                            );
                        }
                    }
                    continue;
                }

                // Unsupported shape
                this.logger.warning(
                    `[addToExistingItemFilters] Slot "${slotName}" has unsupported value on ${id} (expected array or map)`
                );
            }
        }
    }


    private addTraderAssort(trader: string): void 
    {
        const src = this.mydb.traders?.[trader]?.assort;
        const dst = this.db.traders?.[trader]?.assort;
        if (!src || !dst) return;

        // Items
        if (Array.isArray(src.items)) 
        {
            for (const item of src.items) 
            {
                this.db.traders[trader].assort.items.push(item);
            }
        }
        else 
        {
            // in case items is an object map
            for (const key in src.items) 
            {
                this.db.traders[trader].assort.items.push(src.items[key]);
            }
        }

        // Barter scheme
        if (typeof src.barter_scheme === "object") 
        {
            Object.assign(this.db.traders[trader].assort.barter_scheme, src.barter_scheme);
        }

        // Loyalty levels
        if (typeof src.loyal_level_items === "object") 
        {
            for (const item in src.loyal_level_items) 
            {
                this.db.traders[trader].assort.loyal_level_items[item] = modConfig.lvl1Traders ? 1 : src.loyal_level_items[item];
            }
        }
    }

    
    private addLocales(id: string, item?: IItem): void 
    {
        const isItem = typeof item !== "undefined";
    
        for (const localeID of Object.keys(this.db.locales.global)) 
        {
            if (isItem && item?.locales) 
            {
                const entry =
            (Object.prototype.hasOwnProperty.call(item.locales, localeID)
                ? item.locales[localeID]
                : item.locales.en) as ILocale;
    
                const name = `${id} Name`;
                const shortname = `${id} ShortName`;
                const description = `${id} Description`;
    
                if (modConfig.oldLocales) 
                {
                    // 👇 cast the entire locale bucket to any once
                    const g = this.db.locales.global[localeID] as any;
                    g.templates ??= {};
                    g.templates[id] = {
                        Name: entry.Name,
                        ShortName: entry.ShortName,
                        Description: entry.Description
                    };
                }
                else 
                {
                    // modern flat-key strings (no type complaints)
                    this.db.locales.global[localeID][name] = entry.Name;
                    this.db.locales.global[localeID][shortname] = entry.ShortName ?? entry.Name;
                    this.db.locales.global[localeID][description] = entry.Description;
                }
            }
        }
    
        // Preset names
        if (isItem && item?.presets) 
        {
            for (const localeID of Object.keys(this.db.locales.global)) 
            {
                if (modConfig.oldLocales) 
                {
                    // 👇 again, cast the bucket when writing objects
                    const g = this.db.locales.global[localeID] as any;
                    g.preset ??= {};
                    for (const presetId in item.presets) 
                    {
                        g.preset[presetId] = { Name: item.presets[presetId] };
                    }
                }
                else 
                {
                    for (const presetId in item.presets) 
                    {
                        this.db.locales.global[localeID][`${presetId} Name`] = item.presets[presetId];
                    }
                }
            }
        }
    }
    

        
}


module.exports = { mod: new Truenorth() };