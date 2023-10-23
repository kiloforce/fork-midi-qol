import { registerSettings, fetchParams, configSettings, checkRule, enableWorkflow, midiSoundSettings, fetchSoundSettings, midiSoundSettingsBackup, disableWorkflowAutomation, readySettingsSetup } from './module/settings.js';
import { preloadTemplates } from './module/preloadTemplates.js';
import { checkModules, DAE_REQUIRED_VERSION, installedModules, setupModules } from './module/setupModules.js';
import { itemPatching, visionPatching, actorAbilityRollPatching, patchLMRTFY, readyPatching, initPatching, addDiceTermModifiers } from './module/patching.js';
import { initHooks, overTimeJSONData, readyHooks, setupHooks } from './module/Hooks.js';
import { SaferSocket, initGMActionSetup, setupSocket, socketlibSocket } from './module/GMAction.js';
import { setupSheetQol } from './module/sheetQOL.js';
import { TrapWorkflow, DamageOnlyWorkflow, Workflow, DummyWorkflow, WORKFLOWSTATES } from './module/workflow.js';
import { addConcentration, applyTokenDamage, canSense, canSenseModes, checkIncapacitated, checkNearby, checkRange, completeItemRoll, completeItemUse, computeCoverBonus, contestedRoll, displayDSNForRoll, doConcentrationCheck, doOverTimeEffect, findNearby, getChanges, getConcentrationEffect, getDistanceSimple, getDistanceSimpleOld, getSystemCONFIG, getTokenDocument, getTokenPlayerName, getTraitMult, hasCondition, hasUsedBonusAction, hasUsedReaction, isTargetable, midiRenderRoll, MQfromActorUuid, MQfromUuid, playerFor, playerForActor, reactionDialog, reportMidiCriticalFlags, setBonusActionUsed, setReactionUsed, tokenForActor, validRolAbility } from './module/utils.js';
import { ConfigPanel } from './module/apps/ConfigPanel.js';
import { resolveLateTargeting, showItemInfo, templateTokens } from './module/itemhandling.js';
import { RollStats } from './module/RollStats.js';
import { OnUseMacroOptions } from './module/apps/Item.js';
import { MidiKeyManager } from './module/MidiKeyManager.js';
import { MidiSounds } from './module/midi-sounds.js';
import { addUndoChatMessage, getUndoQueue, removeMostRecentWorkflow, showUndoQueue, undoMostRecentWorkflow } from './module/undo.js';
import { showUndoWorkflowApp } from './module/apps/UndowWorkflow.js';
import { TroubleShooter } from './module/apps/TroubleShooter.js';
import { LateTargetingDialog } from './module/apps/LateTargeting.js';

export let debugEnabled = 0;
export let debugCallTiming: any = false;
// 0 = none, warnings = 1, debug = 2, all = 3
export let debug = (...args) => { if (debugEnabled > 1) console.log("DEBUG: midi-qol | ", ...args) };
export let log = (...args) => console.log("midi-qol | ", ...args);
export let warn = (...args) => { if (debugEnabled > 0) console.warn("midi-qol | ", ...args) };
export let error = (...args) => console.error("midi-qol | ", ...args);
export let timelog = (...args) => warn("midi-qol | ", Date.now(), ...args);

declare global {
  interface LenientGlobalVariableTypes {
    game: any; // the type doesn't matter
  }
}
export function getCanvas(): Canvas | undefined {
  if (!canvas || !canvas.scene) {
    error("Canvas/Scene not ready - roll automation will not function");
    return undefined;
  }
  return canvas;
}

export let i18n = key => {
  return game.i18n.localize(key);
};
export let i18nFormat = (key, data = {}) => {
  return game.i18n.format(key, data);
}
export function geti18nOptions(key) {
  const translations = game.i18n.translations["midi-qol"] ?? {};
  //@ts-ignore _fallback not accessible
  const fallback = game.i18n._fallback["midi-qol"] ?? {};
  return translations[key] ?? fallback[key] ?? {};
}
export function geti18nTranslations() {
  // @ts-expect-error _fallback
  return mergeObject(game.i18n._fallback["midi-qol"] ?? {}, game.i18n.translations["midi-qol"] ?? {});
}

export let setDebugLevel = (debugText: string) => {
  debugEnabled = { "none": 0, "warn": 1, "debug": 2, "all": 3 }[debugText] || 0;
  // 0 = none, warnings = 1, debug = 2, all = 3
  if (debugEnabled >= 3) CONFIG.debug.hooks = true;
  debugCallTiming = game.settings.get("midi-qol", "debugCallTiming") ?? false;
}

export let noDamageSaves: string[] = [];
export let undoDamageText;
export let savingThrowText;
export let savingThrowTextAlt;
export let MQdefaultDamageType;
export let midiFlags: string[] = [];
export let allAttackTypes: string[] = []
export let gameStats: RollStats;
export let overTimeEffectsToDelete = {};
export let failedSaveOverTimeEffectsToDelete = {}
export let MQItemMacroLabel: string;
export let MQDeferMacroLabel: string;
export let MQOnUseOptions
export const MESSAGETYPES = {
  HITS: 1,
  SAVES: 2,
  ATTACK: 3,
  DAMAGE: 4,
  ITEM: 0
};
export let cleanSpellName = (name: string): string => {
  // const regex = /[^가-힣一-龠ぁ-ゔァ-ヴーa-zA-Z0-9ａ-ｚＡ-Ｚ０-９々〆〤]/g
  const regex = /[^가-힣一-龠ぁ-ゔァ-ヴーa-zA-Z0-9ａ-ｚＡ-Ｚ０-９а-яА-Я々〆〤]/g
  return name.toLowerCase().replace(regex, '').replace("'", '').replace(/ /g, '');
}

/* ------------------------------------ */
/* Initialize module					*/
/* ------------------------------------ */
Hooks.once("levelsReady", function () {
  //@ts-ignore
  installedModules.set("levels", CONFIG.Levels.API)
});

Hooks.once('init', async function () {
  console.log('midi-qol | Initializing midi-qol');
  allAttackTypes = ["rwak", "mwak", "rsak", "msak"];
  if (game.system.id === "sw5e")
    allAttackTypes = ["rwak", "mwak", "rpak", "mpak"];
  initHooks();
  globalThis.MidiQOL = {checkIncapacitated};
  // Assign custom classes and constants here

  // Register custom module settings
  registerSettings();
  fetchParams();
  fetchSoundSettings();
  // This seems to cause problems for localisation for the items compendium (at least for french)
  // Try a delay before doing this - hopefully allowing localisation to complete
  // If babele is installed then wait for it to be ready
  if (game.modules.get("babele")?.active) {
    Hooks.once("babele.ready", MidiSounds.getWeaponBaseTypes);
  } else {
    setTimeout(MidiSounds.getWeaponBaseTypes, 6000);
  }
  // Preload Handlebars templates
  preloadTemplates();
  // Register custom sheets (if any)
  initPatching();
  addDiceTermModifiers();
  globalThis.MidiKeyManager = new MidiKeyManager();
  globalThis.MidiKeyManager.initKeyMappings();
  Hooks.on("error", (...args) => {
    let [message, err] = args;
    TroubleShooter.recordError(err, message);
  });
});
Hooks.on("dae.modifySpecials", (specKey, specials, _characterSpec) => {
  specials["flags.midi-qol.onUseMacroName"] = ["", CONST.ACTIVE_EFFECT_MODES.CUSTOM];
});
/* ------------------------------------ */
/* Setup module							*/
/* ------------------------------------ */
Hooks.once('setup', function () {
  // Do anything after initialization but before
  // ready
  setupSocket();
  fetchParams();
  fetchSoundSettings();
  itemPatching();
  visionPatching();
  setupModules();
  initGMActionSetup();
  patchLMRTFY();
  setupMidiFlags();
  setupHooks();
  undoDamageText = i18n("midi-qol.undoDamageFrom");
  savingThrowText = i18n("midi-qol.savingThrowText");
  savingThrowTextAlt = i18n("midi-qol.savingThrowTextAlt");
  MQdefaultDamageType = i18n("midi-qol.defaultDamageType");
  MQItemMacroLabel = i18n("midi-qol.ItemMacroText");
  if (MQItemMacroLabel === "midi-qol.ItemMacroText") MQItemMacroLabel = "ItemMacro";
  MQDeferMacroLabel = i18n("midi-qol.DeferText");
  if (MQDeferMacroLabel === "midi-qol.DeferText") MQDeferMacroLabel = "[Defer]";

  let config = getSystemCONFIG();


  if (game.system.id === "dnd5e" || game.system.id === "n5e") {
    config.midiProperties = {};
    // Add additonal vision types? How to modify token properties doing this.
    config.midiProperties["nodam"] = i18n("midi-qol.noDamageSaveProp");
    config.midiProperties["fulldam"] = i18n("midi-qol.fullDamageSaveProp");
    config.midiProperties["halfdam"] = i18n("midi-qol.halfDamageSaveProp");
    config.midiProperties["autoFailFriendly"] = i18n("midi-qol.FailFriendly");
    config.midiProperties["autoSaveFriendly"] = i18n("midi-qol.SaveFriendly");
    config.midiProperties["rollOther"] = i18n("midi-qol.rollOtherProp");
    config.midiProperties["critOther"] = i18n("midi-qol.otherCritProp");
    config.midiProperties["offHandWeapon"] = i18n("midi-qol.OffHandWeapon");
    config.midiProperties["magicdam"] = i18n("midi-qol.magicalDamageProp");
    config.midiProperties["magiceffect"] = i18n("midi-qol.magicalEffectProp");
    config.midiProperties["concentration"] = i18n("midi-qol.concentrationEffectProp");
    config.midiProperties["noConcentrationCheck"] = i18n("midi-qol.noConcentrationEffectProp");
    config.midiProperties["toggleEffect"] = i18n("midi-qol.toggleEffectProp");
    config.midiProperties["ignoreTotalCover"] = i18n("midi-qol.ignoreTotalCover");

    config.damageTypes["midi-none"] = i18n("midi-qol.midi-none");
    // sliver, adamant, spell, nonmagic, magic are all deprecated and should only appear as custom
    config.damageResistanceTypes["silver"] = i18n("midi-qol.NonSilverPhysical");
    config.damageResistanceTypes["adamant"] = i18n("midi-qol.NonAdamantinePhysical");
    config.damageResistanceTypes["spell"] = i18n("midi-qol.spell-damage");
    config.damageResistanceTypes["nonmagic"] = i18n("midi-qol.NonMagical");
    config.damageResistanceTypes["magic"] = i18n("midi-qol.Magical");
    config.damageResistanceTypes["healing"] = config.healingTypes.healing;
    config.damageResistanceTypes["temphp"] = config.healingTypes.temphp;
    config.damageResistanceTypes["healing"] = config.healingTypes.healing;
    config.damageResistanceTypes["temphp"] = config.healingTypes.temphp;

    //@ts-expect-error
    if (isNewerVersion(game.system.version, "2.0.3")) {
      //@ts-expect-error
      game.system.config.traits.di.configKey = "damageResistanceTypes";
      //@ts-expect-error
      game.system.config.traits.dr.configKey = "damageResistanceTypes";
      //@ts-expect-error
      game.system.config.traits.dv.configKey = "damageResistanceTypes";
    }
    config.abilityActivationTypes["reactionpreattack"] = `${i18n("DND5E.Reaction")} ${i18n("midi-qol.reactionPreAttack")}`;
    config.abilityActivationTypes["reactiondamage"] = `${i18n("DND5E.Reaction")} ${i18n("midi-qol.reactionDamaged")}`;
    config.abilityActivationTypes["reactionmanual"] = `${i18n("DND5E.Reaction")} ${i18n("midi-qol.reactionManual")}`;
  } else { // sw5e
    config.midiProperties = {};
    config.midiProperties["nodam"] = i18n("midi-qol.noDamageSaveProp");
    config.midiProperties["fulldam"] = i18n("midi-qol.fullDamageSaveProp");
    config.midiProperties["halfdam"] = i18n("midi-qol.halfDamageSaveProp")
    config.midiProperties["rollOther"] = i18n("midi-qol.rollOtherProp");
    config.midiProperties["critOther"] = i18n("midi-qol.otherCritProp");
    config.midiProperties["concentration"] = i18n("midi-qol.concentrationActivationCondition");

    config.damageTypes["midi-none"] = i18n("midi-qol.midi-none");

    config.abilityActivationTypes["reactiondamage"] = `${i18n("DND5E.Reaction")} ${i18n("midi-qol.reactionDamaged")}`;
    config.abilityActivationTypes["reactionmanual"] = `${i18n("DND5E.Reaction")} ${i18n("midi-qol.reactionManual")}`;
  }

  if (configSettings.allowUseMacro) {
    config.characterFlags["DamageBonusMacro"] = {
      hint: i18n("midi-qol.DamageMacro.Hint"),
      name: i18n("midi-qol.DamageMacro.Name"),
      placeholder: "",
      section: i18n("midi-qol.DAEMidiQOL"),
      type: String
    };
  };
  setupSheetQol();
  createMidiMacros();
  setupMidiQOLApi();
});

/* ------------------------------------ */
/* When ready							*/
/* ------------------------------------ */
Hooks.once('ready', function () {
  registerSettings();
  gameStats = new RollStats();
  actorAbilityRollPatching();
  // has to be done before setup api.
  MQOnUseOptions = geti18nOptions("onUseMacroOptions");
  if (typeof MQOnUseOptions === undefined) MQOnUseOptions = {
    "preTargeting": "Called before targeting is resolved (*)",
    "preItemRoll": "Called before the item is rolled (*)",
    "templatePlaced": "Only called once a template is placed",
    "preambleComplete": "After targeting complete",
    "preAttackRoll": "Before Attack Roll",
    "preCheckHits": "Before Check Hits",
    "postAttackRoll": "After Attack Roll",
    "preSave": "Before Save",
    "postSave": "After Save",
    "preDamageRoll": "Before Damage Roll",
    "postDamageRoll": "After Damage Roll",
    "damageBonus": "return a damage bonus",
    "preDamageApplication": "Before Damage Application",
    "preActiveEffects": "Before Active Effects",
    "postActiveEffects": "After Active Effects ",
    "isAttacked": "Target is attacked",
    "isHit": "Target is hit",
    "preTargetSave": "Target is about to roll a saving throw",
    "isSave": "Target rolled a save",
    "isSaveSuccess": "Target rolled a successful save",
    "isSaveFailure": "Target failed a saving throw",
    "preTargetDamageApplication": "Target is about to be damaged by an item",
    "postTargetEffectApplication": "Target has an effect applied by a rolled item",
    "isDamaged": "Target is damaged by an attack",
    "all": "All"
  }
  OnUseMacroOptions.setOptions(MQOnUseOptions);
  globalThis.MidiQOL.MQOnUseOptions = MQOnUseOptions;

  MidiSounds.midiSoundsReadyHooks();
  if (game.system.id === "dnd5e") {
    getSystemCONFIG().characterFlags["spellSniper"] = {
      name: "Spell Sniper",
      hint: "Spell Sniper",
      section: i18n("DND5E.Feats"),
      type: Boolean
    };

    if (game.user?.isGM) {
      const instanceId = game.settings.get("midi-qol", "instanceId");
      //@ts-expect-error instanceId
      if ([undefined, ""].includes(instanceId)) {
        game.settings.set("midi-qol", "instanceId", randomID());
      }
      const oldVersion = game.settings.get("midi-qol", "last-run-version");
      //@ts-expect-error version
      const newVersion = game.modules.get("midi-qol")?.version;
      //@ts-expect-error
      if (isNewerVersion(newVersion, oldVersion)) {
        console.warn(`midi-qol | instance ${game.settings.get("midi-qol", "instanceId")} version change from ${oldVersion} to ${newVersion}`);
        game.settings.set("midi-qol", "last-run-version", newVersion);
        // look at sending a new version has been installed.
      }
      readySettingsSetup()
    }

  }

  if (game.user?.isGM) {
    if (installedModules.get("levelsautocover") && configSettings.optionalRules.coverCalculation === "levelsautocover" && !game.settings.get("levelsautocover", "apiMode")) {
      game.settings.set("levelsautocover", "apiMode", true)
      if (game.user?.isGM)
        ui.notifications?.warn("midi-qol | setting levels auto cover to api mode", { permanent: true })
    } else if (installedModules.get("levelsautocover") && configSettings.optionalRules.coverCalculation !== "levelsautocover" && game.settings.get("levelsautocover", "apiMode")) {
      ui.notifications?.warn("midi-qol | Levels Auto Cover is in API mode but midi is not using levels auto cover - you may wish to disable api mode", { permanent: true })
    }
  }
  if (game.settings.get("midi-qol", "splashWarnings") && game.user?.isGM) {
    if (game.user?.isGM && !installedModules.get("dae")) {
      ui.notifications?.warn(`Midi-qol requires DAE to be installed and at least version ${DAE_REQUIRED_VERSION} or many automation effects won't work`);
    }
    if (game.user?.isGM && game.modules.get("betterrolls5e")?.active && !installedModules.get("betterrolls5e")) {
      ui.notifications?.warn("Midi QOL requires better rolls to be version 1.6.6 or later");
    }
  }
  //@ts-ignore game.version
  if (isNewerVersion(game.version ? game.version : game.version, "0.8.9")) {
    const noDamageSavesText: string = i18n("midi-qol.noDamageonSaveSpellsv9");
    noDamageSaves = noDamageSavesText.split(",")?.map(s => s.trim()).map(s => cleanSpellName(s));
  } else {
    //@ts-ignore
    noDamageSaves = i18n("midi-qol.noDamageonSaveSpells")?.map(name => cleanSpellName(name));
  }
  checkModules();
  readyHooks();
  readyPatching();
  if (midiSoundSettingsBackup) game.settings.set("midi-qol", "MidiSoundSettings-backup", midiSoundSettingsBackup)

  // Make midi-qol targets hoverable
  $(document).on("mouseover", ".midi-qol-target-name", (e) => {
    const tokenid = e.currentTarget.id
    const tokenObj = canvas?.tokens?.get(tokenid)
    if (!tokenObj) return;
    //@ts-ignore
    tokenObj._hover = true
  });

  if (installedModules.get("betterrolls5e")) {
    //@ts-ignore console:
    ui.notifications?.error("midi-qol automation disabled", { permanent: true, console: true })
    //@ts-ignore console:
    ui.notifications?.error("Please make sure betterrolls5e is disabled", { permanent: true, console: true })
    //@ts-ignore console:
    ui.notifications?.error("Until further notice better rolls is NOT compatible with midi-qol", { permanent: true, console: true })
    disableWorkflowAutomation();
    setTimeout(disableWorkflowAutomation, 2000)
  }
  Hooks.callAll("midi-qol.midiReady");
  if (
    installedModules.get("lmrtfy")
    //@ts-expect-error
    && isNewerVersion("3.1.8", game.modules.get("lmrtfy").version)
    //@ts-expect-error
    && isNewerVersion(game.system.version, "2.1.99")) {
    let abbr = {};

    //@ts-expect-error
    for (let key in CONFIG.DND5E.abilities) {
      //@ts-expect-error
      let abb = game.i18n.localize(CONFIG.DND5E.abilities[key].abbreviation);
      let upperFirstLetter = abb.charAt(0).toUpperCase() + abb.slice(1);
      abbr[`${abb}`] = `DND5E.Ability${upperFirstLetter}`;
    }
    //@ts-expect-error
    LMRTFY.saves = abbr;
    //@ts-expect-error
    LMRTFY.abilities = abbr;
    //@ts-expect-error
    LMRTFY.abilityModifiers = LMRTFY.parseAbilityModifiers();
  }
  if (game.user?.isGM) { // need to improve the test
    const problems = TroubleShooter.collectTroubleShooterData().problems
    for (let problem of problems) {
      const message = `midi-qol ${problem.problemSummary} | Open TroubleShooter to fix`;
      if (problem.severity === "Error")
        ui.notifications?.error(message, { permanent: false });
      else console.warn(message);
    }
  }
});

import { setupMidiTests } from './module/tests/setupTest.js';
Hooks.once("midi-qol.midiReady", () => {
  setupMidiTests();
});

// Add any additional hooks if necessary

// Backwards compatability
function setupMidiQOLApi() {

  //@ts-ignore
  window.MinorQOL = {
    doRoll: () => { console.error("MinorQOL is no longer supported please use MidiQOL.doRoll") },
    applyTokenDamage: () => { console.error("MinorQOL is no longer supported please use MidiQOL.applyTokenDamage") },
  }

  //@ts-expect-error .detectionModes
  const detectionModes = CONFIG.Canvas.detectionModes;
  let InvisibleDisadvantageVisionModes = Object.keys(detectionModes)
  .filter(dm => !detectionModes[dm].imprecise);

  let WallsBlockConditions = [
    "burrow"
  ];

  //@ts-ignore
  globalThis.MidiQOL = mergeObject(globalThis.MidiQOL ?? {}, {
    addConcentration,
    addUndoChatMessage,
    applyTokenDamage,
    canSense,
    canSenseModes,
    checkIncapacitated,
    checkNearby,
    checkRange,
    checkRule: checkRule,
    completeItemRoll,
    completeItemUse,
    computeCoverBonus,
    computeDistance: getDistanceSimple,
    ConfigPanel,
    configSettings: () => { return configSettings },
    contestedRoll,
    DamageOnlyWorkflow,
    debug,
    displayDSNForRoll,
    doConcentrationCheck,
    doOverTimeEffect,
    DummyWorkflow,
    enableWorkflow,
    findNearby,
    gameStats,
    getChanges, // (actorOrItem, key) - what effects on the actor or item target the specific key
    getConcentrationEffect,
    getDistance: getDistanceSimpleOld,
    geti18nOptions,
    geti18nTranslations,
    getTokenPlayerName,
    getTraitMult: getTraitMult,
    getUndoQueue,
    hasCondition,
    hasUsedBonusAction,
    hasUsedReaction,
    incapacitatedConditions: ["incapacitated", "Convenient Effect: Incapacitated", "stunned", "Convenient Effect: Stunned", "paralyzed", "paralysis", "Convenient Effect: Paralyzed"],
    InvisibleDisadvantageVisionModes,
    isTargetable,
    LateTargetingDialog,
    log,
    midiFlags,
    midiRenderRoll,
    midiSoundSettings: () => { return midiSoundSettings },
    MQfromActorUuid,
    MQfromUuid,
    MQFromUuid: MQfromUuid,
    MQOnUseOptions,
    overTimeJSONData,
    playerFor,
    playerForActor,
    reactionDialog,
    removeMostRecentWorkflow,
    reportMidiCriticalFlags: reportMidiCriticalFlags,
    resolveLateTargeting,
    selectTargetsForTemplate: templateTokens,
    setBonusActionUsed,
    setReactionUsed,
    showItemInfo,
    showUndoQueue,
    showUndoWorkflowApp,
    socket: () => { return new SaferSocket(socketlibSocket) },
    testfunc,
    tokenForActor,
    TrapWorkflow,
    TroubleShooter,
    undoMostRecentWorkflow,
    validRolAbility,
    WallsBlockConditions,
    warn,
    Workflow,
    WORKFLOWSTATES,
    moveToken: async (tokenRef: Token | TokenDocument | string, newCenter: { x: number, y: number }, animate: boolean = true) => {
      const tokenUuid = getTokenDocument(tokenRef)?.uuid;
      if (tokenUuid) return socketlibSocket.executeAsGM("moveToken", { tokenUuid, newCenter, animate });
    },
    moveTokenAwayFromPoint: async (targetRef: Token | TokenDocument | string, distance: number, point: { x: number, y: number }, animate: boolean = true) => {
      const targetUuid = getTokenDocument(targetRef)?.uuid;
      if (point && targetUuid && distance)
        return socketlibSocket.executeAsGM("moveTokenAwayFromPoint", { targetUuid, distance, point, animate })
    }
  });
  globalThis.MidiQOL.actionQueue = new Semaphore();
}

export function testfunc(args) {
  console.error(args);
}

// Minor-qol compatibility patching
function doRoll(event = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, type: "none" }, itemName, options = { type: "", versatile: false }) {
  error("doRoll is deprecated and will be removed");
  const speaker = ChatMessage.getSpeaker();
  var actor;
  if (speaker.token) {
    const token = canvas?.tokens?.get(speaker.token)
    actor = token?.actor;
  } else {
    actor = game.actors?.get(speaker.actor ?? "");
  }
  if (!actor) {
    if (debugEnabled > 0) warn("No actor found for ", speaker);
    return;
  }
  let pEvent = {
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    type: (event?.type === "contextmenu") || options.versatile ? "contextmenu" : ""
  }
  let item = actor?.items?.get(itemName) // see if we got an itemId
  if (!item) item = actor?.items?.find(i => i.name === itemName && (!options.type || i.type === options.type));
  if (item) {
    return item.roll({ event: pEvent })
  } else {
    ui.notifications?.warn(game.i18n.format("DND5E.ActionWarningNoItem", { item: itemName, name: actor.name }));
  }
}

function setupMidiFlags() {
  let config = getSystemCONFIG();
  midiFlags.push("flags.midi-qol.advantage.all")
  midiFlags.push("flags.midi-qol.disadvantage.all")
  midiFlags.push("flags.midi-qol.advantage.attack.all")
  midiFlags.push("flags.midi-qol.disadvantage.attack.all")
  midiFlags.push("flags.midi-qol.critical.all")
  midiFlags.push(`flags.midi-qol.max.damage.all`);
  midiFlags.push(`flags.midi-qol.min.damage.all`);
  midiFlags.push(`flags.midi-qol.grants.max.damage.all`);
  midiFlags.push(`flags.midi-qol.grants.min.damage.all`);
  midiFlags.push("flags.midi-qol.noCritical.all");
  midiFlags.push("flags.midi-qol.fail.all");
  midiFlags.push("flags.midi-qol.fail.attack.all");
  midiFlags.push("flags.midi-qol.success.attack.all");
  midiFlags.push(`flags.midi-qol.grants.advantage.attack.all`);
  midiFlags.push("flags.midi-qol.grants.advantage.save.all")
  midiFlags.push("flags.midi-qol.grants.advantage.check.all")
  midiFlags.push("flags.midi-qol.grants.advantage.skill.all")
  midiFlags.push(`flags.midi-qol.grants.disadvantage.attack.all`);
  midiFlags.push("flags.midi-qol.grants.disadvantage.save.all")
  midiFlags.push("flags.midi-qol.grants.disadvantage.check.all")
  midiFlags.push("flags.midi-qol.grants.disadvantage.skill.all")

  midiFlags.push(`flags.midi-qol.grants.fail.advantage.attack.all`);
  midiFlags.push(`flags.midi-qol.grants.fail.disadvantage.attack.all`);
  midiFlags.push(`flags.midi-qol.neverTarget`);

  // TODO work out how to do grants damage.max
  midiFlags.push(`flags.midi-qol.grants.attack.success.all`);
  midiFlags.push(`flags.midi-qol.grants.attack.fail.all`);
  midiFlags.push(`flags.midi-qol.grants.attack.bonus.all`);
  midiFlags.push(`flags.midi-qol.grants.critical.all`);
  midiFlags.push(`flags.midi-qol.grants.critical.range`);
  midiFlags.push('flags.midi-qol.grants.criticalThreshold');
  midiFlags.push(`flags.midi-qol.fail.critical.all`);
  midiFlags.push(`flags.midi-qol.advantage.concentration`)
  midiFlags.push(`flags.midi-qol.disadvantage.concentration`)
  midiFlags.push("flags.midi-qol.ignoreNearbyFoes");
  midiFlags.push("flags.midi-qol.")
  midiFlags.push(`flags.midi-qol.concentrationSaveBonus`);
  midiFlags.push(`flags.midi-qol.potentCantrip`);
  midiFlags.push(`flags.midi-qol.sculptSpells`);
  midiFlags.push(`flags.midi-qol.carefulSpells`);
  midiFlags.push("flags.midi-qol.magicResistance.all");
  midiFlags.push("flags.midi-qol.magicResistance.save.all");
  midiFlags.push("flags.midi-qol.magicResistance.check.all");
  midiFlags.push("flags.midi-qol.magicResistance.skill.all");
  midiFlags.push("flags.midi-qol.magicVulnerability.all")
  midiFlags.push("flags.midi-qol.rangeOverride.attack.all")

  let attackTypes = allAttackTypes.concat(["heal", "other", "save", "util"])

  attackTypes.forEach(at => {
    midiFlags.push(`flags.midi-qol.advantage.attack.${at}`);
    midiFlags.push(`flags.midi-qol.disadvantage.attack.${at}`);
    midiFlags.push(`flags.midi-qol.fail.attack.${at}`);
    midiFlags.push(`flags.midi-qol.success.attack.${at}`);
    midiFlags.push(`flags.midi-qol.critical.${at}`);
    midiFlags.push(`flags.midi-qol.noCritical.${at}`);
    midiFlags.push(`flags.midi-qol.grants.advantage.attack.${at}`);
    midiFlags.push(`flags.midi-qol.grants.fail.advantage.attack.${at}`);
    midiFlags.push(`flags.midi-qol.grants.disadvantage.attack.${at}`);
    midiFlags.push(`flags.midi-qol.grants.fail.disadvantage.attack.${at}`);
    midiFlags.push(`flags.midi-qol.grants.critical.${at}`);
    midiFlags.push(`flags.midi-qol.fail.critical.${at}`);
    midiFlags.push(`flags.midi-qol.grants.attack.bonus.${at}`);
    midiFlags.push(`flags.midi-qol.grants.attack.success.${at}`);
    if (at !== "heal") midiFlags.push(`flags.midi-qol.DR.${at}`);
    midiFlags.push(`flags.midi-qol.max.damage.${at}`);
    midiFlags.push(`flags.midi-qol.min.damage.${at}`);
    midiFlags.push(`flags.midi-qol.grants.max.damage.${at}`);
    midiFlags.push(`flags.midi-qol.grants.min.damage.${at}`);
    midiFlags.push(`flags.midi-qol.optional.NAME.attack.${at}`);
    midiFlags.push(`flags.midi-qol.optional.NAME.attack.fail.${at}`);

    midiFlags.push(`flags.midi-qol.optional.NAME.damage.${at}`);
    midiFlags.push(`flags.midi-qol.rangeOverride.attack.${at}`);
  });
  midiFlags.push("flags.midi-qol.advantage.ability.all");
  midiFlags.push("flags.midi-qol.advantage.ability.check.all");
  midiFlags.push("flags.midi-qol.advantage.ability.save.all");
  midiFlags.push("flags.midi-qol.disadvantage.ability.all");
  midiFlags.push("flags.midi-qol.disadvantage.ability.check.all");
  midiFlags.push("flags.midi-qol.disadvantage.ability.save.all");
  midiFlags.push("flags.midi-qol.fail.ability.all");
  midiFlags.push("flags.midi-qol.fail.ability.check.all");
  midiFlags.push("flags.midi-qol.fail.ability.save.all");
  midiFlags.push("flags.midi-qol.superSaver.all");
  midiFlags.push("flags.midi-qol.semiSuperSaver.all");
  midiFlags.push("flags.midi-qol.max.ability.save.all");
  midiFlags.push("flags.midi-qol.max.ability.check.all");
  midiFlags.push("flags.midi-qol.min.ability.save.all");
  midiFlags.push("flags.midi-qol.min.ability.check.all");
  midiFlags.push("flags.midi-qol.sharpShooter");

  Object.keys(config.abilities).forEach(abl => {
    midiFlags.push(`flags.midi-qol.advantage.ability.check.${abl}`);
    midiFlags.push(`flags.midi-qol.disadvantage.ability.check.${abl}`);
    midiFlags.push(`flags.midi-qol.advantage.ability.save.${abl}`);
    midiFlags.push(`flags.midi-qol.disadvantage.ability.save.${abl}`);
    midiFlags.push(`flags.midi-qol.advantage.attack.${abl}`);
    midiFlags.push(`flags.midi-qol.disadvantage.attack.${abl}`);
    midiFlags.push(`flags.midi-qol.fail.ability.check.${abl}`);
    midiFlags.push(`flags.midi-qol.fail.ability.save.${abl}`);
    midiFlags.push(`flags.midi-qol.superSaver.${abl}`);
    midiFlags.push(`flags.midi-qol.semiSuperSaver.${abl}`);
    midiFlags.push(`flags.midi-qol.max.ability.save.${abl}`);
    midiFlags.push(`flags.midi-qol.min.ability.save.${abl}`);
    midiFlags.push(`flags.midi-qol.max.ability.check.${abl}`);
    midiFlags.push(`flags.midi-qol.min.ability.check.${abl}`);
    midiFlags.push(`flags.midi-qol.optional.NAME.save.${abl}`);
    midiFlags.push(`flags.midi-qol.optional.NAME.save.fail.${abl}`);
    midiFlags.push(`flags.midi-qol.optional.NAME.check.${abl}`);
    midiFlags.push(`flags.midi-qol.optional.NAME.check.fail.${abl}`);
    midiFlags.push(`flags.midi-qol.magicResistance.${abl}`);
    midiFlags.push(`flags.midi-qol.magicVulnerability.all.${abl}`);
    midiFlags.push(`flags.midi-qol.grants.advantage.save.${abl}`);
    midiFlags.push(`flags.midi-qol.grants.advantage.check.${abl}`);
    midiFlags.push(`flags.midi-qol.grants.advantage.skill.${abl}`);
    midiFlags.push(`flags.midi-qol.grants.disadvantage.save.${abl}`);
    midiFlags.push(`flags.midi-qol.grants.disadvantage.check.${abl}`);
    midiFlags.push(`flags.midi-qol.grants.disadvantage.skill.${abl}`);
  })

  midiFlags.push(`flags.midi-qol.advantage.skill.all`);
  midiFlags.push(`flags.midi-qol.disadvantage.skill.all`);
  midiFlags.push(`flags.midi-qol.fail.skill.all`);
  midiFlags.push("flags.midi-qol.max.skill.all");
  midiFlags.push("flags.midi-qol.min.skill.all");
  Object.keys(config.skills).forEach(skill => {
    midiFlags.push(`flags.midi-qol.advantage.skill.${skill}`);
    midiFlags.push(`flags.midi-qol.disadvantage.skill.${skill}`);
    midiFlags.push(`flags.midi-qol.fail.skill.${skill}`);
    midiFlags.push(`flags.midi-qol.max.skill.${skill}`);
    midiFlags.push(`flags.midi-qol.min.skill.${skill}`);
    midiFlags.push(`flags.midi-qol.optional.NAME.skill.${skill}`);
  })
  midiFlags.push(`flags.midi-qol.advantage.deathSave`);
  midiFlags.push(`flags.midi-qol.disadvantage.deathSave`);

  if (game.system.id === "dnd5e") {
    // fix for translations
    ["vocal", "somatic", "material"].forEach(comp => {
      midiFlags.push(`flags.midi-qol.fail.spell.${comp.toLowerCase()}`);
    });
    midiFlags.push(`flags.midi-qol.DR.all`);
    midiFlags.push(`flags.midi-qol.DR.non-magical`);
    midiFlags.push(`flags.midi-qol.DR.non-magical-physical`);
    midiFlags.push(`flags.midi-qol.DR.non-silver`);
    midiFlags.push(`flags.midi-qol.DR.non-adamant`);
    midiFlags.push(`flags.midi-qol.DR.non-physical`);
    midiFlags.push(`flags.midi-qol.DR.final`);
    midiFlags.push(`flags.midi-qol.damage.reroll-kh`);
    midiFlags.push(`flags.midi-qol.damage.reroll-kl`);

    Object.keys(config.damageResistanceTypes).forEach(dt => {
      midiFlags.push(`flags.midi-qol.DR.${dt}`);
    })
    midiFlags.push(`flags.midi-qol.DR.healing`);
    midiFlags.push(`flags.midi-qol.DR.temphp`);
  } else if (game.system.id === "sw5e") {
    midiFlags.push(`flags.midi-qol.DR.all`);
    midiFlags.push(`flags.midi-qol.DR.final`);
    Object.keys(config.damageResistanceTypes).forEach(dt => {
      midiFlags.push(`flags.midi-qol.DR.${dt}`);
    })
    midiFlags.push(`flags.midi-qol.DR.healing`);
    midiFlags.push(`flags.midi-qol.DR.temphp`);
  }

  midiFlags.push(`flags.midi-qol.optional.NAME.attack.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.attack.fail.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.damage.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.check.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.save.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.check.fail.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.save.fail.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.label`);
  midiFlags.push(`flags.midi-qol.optional.NAME.skill.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.skill.fail.all`);
  midiFlags.push(`flags.midi-qol.optional.NAME.count`);
  midiFlags.push(`flags.midi-qol.optional.NAME.countAlt`);
  midiFlags.push(`flags.midi-qol.optional.NAME.ac`);
  midiFlags.push(`flags.midi-qol.optional.NAME.criticalDamage`);
  midiFlags.push(`flags.midi-qol.optional.Name.onUse`);
  midiFlags.push(`flags.midi-qol.optional.NAME.macroToCall`);

  midiFlags.push(`flags.midi-qol.uncanny-dodge`);
  midiFlags.push(`flags.midi-qol.OverTime`);
  midiFlags.push("flags.midi-qol.inMotion");
  //@ts-ignore
  const damageTypes = Object.keys(config.damageTypes);
  for (let key of damageTypes) {
    midiFlags.push(`flags.midi-qol.absorption.${key}`);
  }

  /*
  midiFlags.push(`flags.midi-qol.grants.advantage.attack.all`);
  midiFlags.push(`flags.midi-qol.grants.disadvantage.attack.all`);
  midiFlags.push(``);

  midiFlags.push(``);
  midiFlags.push(``);
  */
  if (installedModules.get("dae")) {
    const initDAE = async () => {
      for (let i = 0; i < 100; i++) {
        if (globalThis.DAE) {
          globalThis.DAE.addAutoFields(midiFlags);
          return true;
        } else {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      return false;
    };
    initDAE().then(value => { if (!value) console.error(`midi-qol | initDae settings failed`) });
  }
}

// Revisit to find out how to set execute as GM
const MQMacros = [
  {
    name: "MidiQOL.showTroubleShooter",
    checkVersion: true,
    version: "11.0.9",
    permission: { default: 1 },
    commandText: `
    new MidiQOL.TroubleShooter().render(true)`
  },
  {
    name: "MidiQOL.exportTroubleShooterData",
    checkVersion: true,
    version: "11.0.9.1",
    permission: { default: 1 },
    commandText: `MidiQOL.TroubleShooter.exportTroubleShooterData()`
  }
]
export async function createMidiMacros() {
  const midiVersion = "11.0.9"
  if (game?.user?.isGM) {
    for (let macroSpec of MQMacros) {
      try {
        let existingMacros = game.macros?.filter(m => m.name === macroSpec.name) ?? [];
        if (existingMacros.length > 0) {
          for (let macro of existingMacros) {
            if (macroSpec.checkVersion
              //@ts-expect-error .flags
              && !isNewerVersion(macroSpec.version, (macro.flags["midi-version"] ?? "0.0.0")))
              continue; // already up to date
            await macro.update({
              command: macroSpec.commandText,
              "flags.midi-version": macroSpec.version
            });
          }
        } else {
          const macroData = {
            _id: null,
            name: macroSpec.name,
            type: "script",
            author: game.user.id,
            img: 'icons/svg/dice-target.svg',
            scope: 'global',
            command: macroSpec.commandText,
            folder: null,
            sort: 0,
            permission: {
              default: 1,
            },
            flags: { "midi-version": macroSpec.version ?? "midiVersion" }
          };
          //@ts-expect-error
          await Macro.createDocuments([macroData]);
          log(`Macro ${macroData.name} created`);
        }
      } catch (err) {
        const message = `createMidiMacros | falied to create macro ${macroSpec.name}`
        TroubleShooter.recordError(err, message);
        error(err, message);
      }
    }
  }
}


const midiOldErrorHandler = globalThis.onerror;
function midiOnerror(event: string | Event, source?: string | undefined, lineno?: number | undefined, colno?: number | undefined, error?: Error) {
  console.warn("midi-qol detected error", event, source, lineno, colno, error);
  TroubleShooter.recordError(error, "uncaught global error");
  if (midiOldErrorHandler) return midiOldErrorHandler(event, source, lineno, colno, error);
  return false;
}
// globalThis.onerror = midiOnerror;
