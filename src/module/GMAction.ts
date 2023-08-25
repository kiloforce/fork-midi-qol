import { checkRule, configSettings } from "./settings.js";
import { i18n, log, warn, gameStats, getCanvas, error, debugEnabled, debugCallTiming, geti18nOptions, debug } from "../midi-qol.js";
import { canSense, completeItemUse, getToken, getTokenDocument, gmExpirePerTurnBonusActions, gmOverTimeEffect, MQfromActorUuid, MQfromUuid, promptReactions } from "./utils.js";
import { ddbglPendingFired } from "./chatMesssageHandling.js";
import { Workflow, WORKFLOWSTATES } from "./workflow.js";
import { bonusCheck } from "./patching.js";
import { queueUndoData, startUndoWorkflow, updateUndoChatCardUuids, _removeMostRecentWorkflow, _undoMostRecentWorkflow } from "./undo.js";
import { TroubleShooter } from "./apps/TroubleShooter.js";

export var socketlibSocket: any = undefined;
var traitList = { di: {}, dr: {}, dv: {} };

export let setupSocket = () => {
  socketlibSocket = globalThis.socketlib.registerModule("midi-qol");
  socketlibSocket.register("createReverseDamageCard", createReverseDamageCard);
  socketlibSocket.register("removeEffects", removeEffects);
  socketlibSocket.register("createEffects", createEffects);
  socketlibSocket.register("updateEffects", updateEffects);
  socketlibSocket.register("updateEntityStats", GMupdateEntityStats)
  socketlibSocket.register("removeStatsForActorId", removeActorStats);
  socketlibSocket.register("monksTokenBarSaves", monksTokenBarSaves);
  socketlibSocket.register("rollAbility", rollAbility);
  socketlibSocket.register("createChatMessage", createChatMessage);
  socketlibSocket.register("chooseReactions", localDoReactions);
  socketlibSocket.register("addConvenientEffect", addConvenientEffect);
  socketlibSocket.register("deleteItemEffects", deleteItemEffects);
  socketlibSocket.register("createActor", createActor);
  socketlibSocket.register("deleteToken", deleteToken);
  socketlibSocket.register("ddbglPendingFired", ddbglPendingFired);
  socketlibSocket.register("completeItemUse", _completeItemUse);
  socketlibSocket.register("applyEffects", _applyEffects);
  socketlibSocket.register("bonusCheck", _bonusCheck);
  socketlibSocket.register("gmOverTimeEffect", _gmOverTimeEffect);
  socketlibSocket.register("_gmExpirePerTurnBonusActions", gmExpirePerTurnBonusActions);
  socketlibSocket.register("_gmUnsetFlag", _gmUnsetFlag);
  socketlibSocket.register("_gmSetFlag", _gmSetFlag);
  socketlibSocket.register("startUndoWorkflow", startUndoWorkflow);
  socketlibSocket.register("queueUndoData", queueUndoData);
  socketlibSocket.register("updateUndoChatCardUuids", updateUndoChatCardUuids)
  socketlibSocket.register("undoMostRecentWorkflow", _undoMostRecentWorkflow);
  socketlibSocket.register("removeMostRecentWorkflow", _removeMostRecentWorkflow);
  socketlibSocket.register("moveToken", _moveToken);
  socketlibSocket.register("moveTokenAwayFromPoint", _moveTokenAwayFromPoint);
  // socketlibSocket.register("canSense", _canSense);
}

function paranoidCheck(action: string, actor: any, data: any): boolean {
  return true;
}
export async function removeEffects(data: { actorUuid: string; effects: string[]; options: {} }) {
  debug("removeEffects started");
  let removeFunc = async () => {
    try {
      debug("removeFunc: remove effects started")
      const actor = MQfromActorUuid(data.actorUuid);
      if (configSettings.paranoidGM && !paranoidCheck("removeEffects", actor, data)) return "gmBlocked";
      const effectIds = data.effects.filter(efId => actor?.effects.find(effect => efId === effect.id));
      if (effectIds?.length > 0) return actor?.deleteEmbeddedDocuments("ActiveEffect", effectIds, data.options)
    } catch (err) {
      const message = `GMACTION: remove effects error for ${data?.actorUuid}`;
      console.warn(message, err);
      TroubleShooter.recordError(err, message);
    } finally {
      warn("removeFunc: remove effects completed")
    }
  };
  // Using the seamphore queue leads to quite a few potential cases of deadlock - disabling for now
  // if (globalThis.DAE?.actionQueue) return globalThis.DAE.actionQueue.add(removeFunc)
  // else return removeFunc();
  return removeFunc();

}

export async function createEffects(data: { actorUuid: string, effects: any[] }) {
  const createEffectsFunc = async () => {
    const actor = MQfromActorUuid(data.actorUuid);
    for (let effect of data.effects) { // override default foundry behaviour of blank being transfer
      if (effect.transfer === undefined) effect.transfer = false;
    }
    return actor?.createEmbeddedDocuments("ActiveEffect", data.effects)
  };
  return await createEffectsFunc();
  /* This seems to cause a deadlock 
  if (globalThis.DAE?.actionQueue) return globalThis.DAE.actionQueue.add(createEffectsFunc)
  else return createEffectsFunc();
  */
}

export async function updateEffects(data: { actorUuid: string, updates: any[] }) {
  const actor = MQfromActorUuid(data.actorUuid);
  return actor?.updateEmbeddedDocuments("ActiveEffect", data.updates);
}

export function removeActorStats(data: { actorId: any }) {
  return gameStats.GMremoveActorStats(data.actorId)
}

export function GMupdateEntityStats(data: { id: any; currentStats: any; }) {
  return gameStats.GMupdateEntity(data)
}

export async function timedExecuteAsGM(toDo: string, data: any) {
  if (!debugCallTiming) return socketlibSocket.executeAsGM(toDo, data);
  const start = Date.now();
  data.playerId = game.user?.id;
  const returnValue = await socketlibSocket.executeAsGM(toDo, data);
  log(`executeAsGM: ${toDo} elapsed: ${Date.now() - start}ms`)
  return returnValue;
}

export async function timedAwaitExecuteAsGM(toDo: string, data: any) {
  if (!debugCallTiming) return await socketlibSocket.executeAsGM(toDo, data);
  const start = Date.now();
  const returnValue = await socketlibSocket.executeAsGM(toDo, data);
  log(`await executeAsGM: ${toDo} elapsed: ${Date.now() - start}ms`)
  return returnValue;
}

export async function _gmUnsetFlag(data: { base: string, key: string, actorUuid: string }) {
  //@ts-expect-error
  let actor = fromUuidSync(data.actorUuid);
  actor = actor.actor ?? actor;
  if (!actor) return undefined;
  return actor.unsetFlag(data.base, data.key)
}

export async function _gmSetFlag(data: { base: string, key: string, value: any, actorUuid: string }) {
  //@ts-expect-error
  let actor = fromUuidSync(data.actorUuid);
  actor = actor.actor ?? actor;
  if (!actor) return undefined;
  return actor.setFlag(data.base, data.key, data.value)
}

// Seems to work doing it on the client instead.
export async function _canSense(data: { tokenUuid, targetUuid }) {
  //@ts-expect-error fromUuidSync
  const token = fromUuidSync(data.tokenUuid)?.object;
  //@ts-expect-error fromUuidSync
  const target = fromUuidSync(data.targetUuid)?.object;
  if (!target || !token) return true;
  if (!token.vision.active) {
    token.vision.initialize({
      x: token.center.x,
      y: token.center.y,
      radius: Math.clamped(token.sightRange, 0, canvas?.dimensions?.maxR ?? 0),
      externalRadius: Math.max(token.mesh.width, token.mesh.height) / 2,
      angle: token.document.sight.angle,
      contrast: token.document.sight.contrast,
      saturation: token.document.sight.saturation,
      brightness: token.document.sight.brightness,
      attenuation: token.document.sight.attenuation,
      rotation: token.document.rotation,
      visionMode: token.document.sight.visionMode,
      color: globalThis.Color.from(token.document.sight.color),
      isPreview: !!token._original,
      //@ts-expect-error specialStatusEffects
      blinded: token.document.hasStatusEffect(CONFIG.specialStatusEffects.BLIND)
    });
  }
  return canSense(token, target);
}

export async function _gmOverTimeEffect(data: { actorUuid, effectUuid, startTurn, options }) {
  const actor = MQfromActorUuid(data.actorUuid);
  const effect = MQfromUuid(data.effectUuid)
  log("Called _gmOvertime", actor.name, effect.name)
  return gmOverTimeEffect(actor, effect, data.startTurn, data.options)
}

export async function _bonusCheck(data: { actorUuid, result, rollType, selector }) {
  const tokenOrActor: any = await fromUuid(data.actorUuid);
  const actor = tokenOrActor?.actor ?? tokenOrActor;
  const roll = Roll.fromJSON(data.result);
  if (actor) return await bonusCheck(actor, roll, data.rollType, data.selector);
  else return null;
}
export async function _applyEffects(data: { workflowId: string, targets: string[] }) {
  let result;
  try {
    const workflow = Workflow.getWorkflow(data.workflowId);
    if (!workflow) return result;
    workflow.forceApplyEffects = true;
    const targets: Set<Token> = new Set();
    //@ts-ignore
    for (let targetUuid of data.targets) targets.add(await fromUuid(targetUuid));

    workflow.applicationTargets = targets;
    if (workflow.applicationTargets.size > 0) result = await workflow.next(WORKFLOWSTATES.APPLYDYNAMICEFFECTS);
    return result;
  } catch (err) {
    const message = `_applyEffects | remote apply effects error`;
    console.warn(message, err);
    TroubleShooter.recordError(err, message);
  }
  return result;
}

async function _completeItemUse(data: {
  itemData: any, actorUuid: string, config: any, options: any, targetUuids: string[], workflowData: boolean
}) {
  if (!game.user) return null;
  let { itemData, actorUuid, config, options } = data;
  let actor: any = await fromUuid(actorUuid);
  if (actor.actor) actor = actor.actor;
  //@ts-ignore v10
  let ownedItem: Item = new CONFIG.Item.documentClass(itemData, { parent: actor, keepId: true });
  const workflow = await completeItemUse(ownedItem, config, options);
  if (data.options?.workflowData) return workflow.getMacroData(); // can't return the workflow
  else return true;
}

async function createActor(data) {
  await CONFIG.Actor.documentClass.createDocuments([data.actorData]);
}

async function deleteToken(data: { tokenUuid: string }) {
  const token = await fromUuid(data.tokenUuid);
  if (token) { // token will be a token document.
    token.delete();
  }
}
export async function deleteItemEffects(data: { targets, origin: string, ignore: string[], ignoreTransfer: boolean }) {
  debug("deleteItemEffects: started", globalThis.DAE?.actionQueue)
  let deleteFunc = async () => {
    let { targets, origin, ignore } = data;
    for (let idData of targets) {
      let actor = idData.tokenUuid ? MQfromActorUuid(idData.tokenUuid) : idData.actorUuid ? MQfromUuid(idData.actorUuid) : undefined;
      if (actor?.actor) actor = actor.actor;
      if (!actor) {
        warn("could not find actor for ", idData.tokenUuid);
        continue;
      }
      const effectsToDelete = actor?.effects?.filter(ef => {
        return ef.origin === origin && !ignore.includes(ef.uuid) && (!data.ignoreTransfer || ef.flags?.dae?.transfer !== true)
      });
      debug("deleteItemEffects: effectsToDelete ", actor.name, effectsToDelete)
      if (effectsToDelete?.length > 0) {
        try {
          // for (let ef of effectsToDelete) ef.delete();
          await ActiveEffect.deleteDocuments(effectsToDelete.map(ef => ef.id), { parent: actor });
          // await actor.deleteEmbeddedDocuments("ActiveEffect", effectsToDelete.map(ef => ef.id), {strict: false, invalid: false});
        } catch (err) {
          const message = `delete item effects failed for ${actor?.name} ${actor?.uuid}`;
          console.warn(message, err);
          TroubleShooter.recordError(err, message);
        };
      }
      debug("deleteItemEffects: completed", actor.name)
    }
    if (globalThis.Sequencer) await globalThis.Sequencer.EffectManager.endEffects({ origin })
  }
  if (globalThis.DAE?.actionQueue) return globalThis.DAE.actionQueue.add(deleteFunc)
  else return deleteFunc();
}

async function addConvenientEffect(options) {
  let { effectName, actorUuid, origin } = options;
  const actorToken: any = await fromUuid(actorUuid);
  const actor = actorToken?.actor ?? actorToken;

  console.warn("midi-qol | Deprecated. Call await game.dfreds.effectInterface?.addEffect({ effectName, uuid: actorUuid, origin }) instead")
  //@ts-ignore
  await game.dfreds.effectInterface?.addEffect({ effectName, uuid: actorUuid, origin });
}

async function localDoReactions(data: { tokenUuid: string; reactionItemUuidList: string[], triggerTokenUuid: string, reactionFlavor: string; triggerType: string; options: any }) {
  if (data.options.itemUuid) {
    data.options.item = MQfromUuid(data.options.itemUuid);
  }
  // reactonItemUuidList can't used since magic items don't have a uuid, so must always look them up locally.
  const result = await promptReactions(data.tokenUuid, [] /*data.reactionItemUuidList */, data.triggerTokenUuid, data.reactionFlavor, data.triggerType, data.options)
  return result;
}

export function initGMActionSetup() {
  traitList.di = i18n("DND5E.DamImm");
  traitList.dr = i18n("DND5E.DamRes");
  traitList.dv = i18n("DND5E.DamVuln");
  traitList.di = "di";
  traitList.dr = "dr";
  traitList.dv = "dv";
}

export async function createChatMessage(data: { chatData: any; }) {
  const messageData = getProperty(data, "chatData.messageData") ?? {};
  messageData.user = game.user?.id;
  return await ChatMessage.create(data.chatData);
}

export async function rollAbility(data: { request: string; targetUuid: string; ability: string; options: any; }) {
  if (data.request === "test") data.request = "abil";
  const actor = MQfromActorUuid(data.targetUuid);
  if (!actor) {
    error(`GMAction.rollAbility | no actor for ${data.targetUuid}`)
    return {};
  }
  const requestedChatMessage = data.options?.chatMessage ?? true;
  return new Promise(async (resolve) => {
    let timeoutId;
    let result;
    if (configSettings.playerSaveTimeout > 0) timeoutId = setTimeout(async () => {
      warn(`Roll request for {actor.name}timed out. Doing roll`);
      console.warn("Roll request timed out. Doing roll", data.options);
      data.options.fastForward = true; // assume player is asleep force roll without dialog
      data.options.chatMessage = requestedChatMessage;
      if (data.request === "save") result = await actor.rollAbilitySave(data.ability, data.options)
      else if (data.request === "abil") result = await actor.rollAbilityTest(data.ability, data.options);
      else if (data.request === "skill") result = await actor.rollSkill(data.ability, data.options);
      resolve(result ?? {});
    }, configSettings.playerSaveTimeout * 1000);
    if (data.request === "save") result = await actor.rollAbilitySave(data.ability, data.options)
    else if (data.request === "abil") result = await actor.rollAbilityTest(data.ability, data.options);
    else if (data.request === "skill") result = await actor.rollSkill(data.ability, data.options);
    if (timeoutId) clearTimeout(timeoutId);
    resolve(result ?? {})
  });
}

export function monksTokenBarSaves(data: { tokenData: any[]; request: any; silent: any; rollMode: string; dc: number | undefined, isMagicSave: boolean | undefined }) {
  // let tokens = data.tokens.map((tuuid: any) => new Token(MQfromUuid(tuuid)));

  // TODO come back and see what things can be passed to this.
  //@ts-ignore MonksTokenBar
  game.MonksTokenBar?.requestRoll(
    data.tokenData,
    {
      request: data.request,
      silent: data.silent,
      rollmode: data.rollMode,
      dc: data.dc,
      isMagicSave: data.isMagicSave
    });
}

async function createReverseDamageCard(data: { damageList: any; autoApplyDamage: string; flagTags: any, sender: string, charName: string, actorId: string, updateContext: any, forceApply: boolean }): Promise<string[]> {
  let cardIds: string[] = [];
  let id = await createPlayerDamageCard(data);
  if (id) cardIds.push(id);
  if (data.damageList.some(di => di.wasHit)) {
    id = await createGMReverseDamageCard(data, true);
    if (id) cardIds.push(id);
  }
  if (data.damageList.some(di => !di.wasHit) && ["yesCardMisses", "noCardMisses"].includes(data.autoApplyDamage)) {
    id = await createGMReverseDamageCard(data, false);
    if (id) cardIds.push(id);
  }
  return cardIds;
}

async function prepareDamageListItems(data: {
  damageList: any; autoApplyDamage: string; flagTags: any, updateContext: any, forceApply: boolean
},
  templateData, tokenIdList, createPromises: boolean = false, showNPC: boolean = true, doHits: boolean = true): Promise<Array<Promise<any>>> {
  const damageList = data.damageList;
  let promises: Promise<any>[] = [];

  for (let damageItem of damageList) {
    let { tokenId, tokenUuid, actorId, actorUuid, oldHP, oldTempHP, newTempHP, tempDamage, hpDamage, totalDamage, appliedDamage, sceneId, oldVitality, newVitality, wasHit } = damageItem;
    if (doHits && !wasHit) continue;
    if (!doHits && wasHit) continue;
    let tokenDocument;
    let actor;
    if (tokenUuid) {
      tokenDocument = MQfromUuid(tokenUuid);
      actor = tokenDocument?.actor ?? tokenDocument ?? MQfromActorUuid(actorUuid);
    }
    else
      actor = MQfromActorUuid(actorUuid)

    if (!actor) {
      if (debugEnabled > 0) warn(`GMAction: reverse damage card could not find actor to update HP tokenUuid ${tokenUuid} actorUuid ${actorUuid}`);
      continue;
    }
    if (!showNPC && !actor.hasPlayerOwner) continue;
    let newHP = Math.max(0, oldHP - hpDamage);
    if (createPromises && doHits && (["yes", "yesCard", "yesCardNPC", "yesCardMisses"].includes(data.autoApplyDamage) || data.forceApply)) {
      if ((newHP !== oldHP || newTempHP !== oldTempHP) && (data.autoApplyDamage !== "yesCardNPC" || actor.type !== "character")) {
        const updateContext = mergeObject({ dhp: -appliedDamage, damageItem }, data.updateContext ?? {});
        if (actor.isOwner) {
          //@ts-ignore
          promises.push(actor.update({ "system.attributes.hp.temp": newTempHP, "system.attributes.hp.value": newHP, "flags.dae.damageApplied": appliedDamage }, updateContext));
        }
      } else if (oldVitality !== newVitality && actor.isOwner && doHits) {
        const vitalityResource = checkRule("vitalityResource");
        if (typeof vitalityResource === "string")
          promises.push(actor.update({ [vitalityResource.trim()]: newVitality }))
      }
    }
    tokenIdList.push({ tokenId, tokenUuid, actorUuid, actorId, oldTempHP: oldTempHP, oldHP, totalDamage: Math.abs(totalDamage), newHP, newTempHP, damageItem, oldVitality, newVitality });

    let img = tokenDocument?.texture.src || actor.img;
    if (configSettings.usePlayerPortrait && actor.type === "character")
      img = actor?.img || tokenDocument?.texture.src;
    if (VideoHelper.hasVideoExtension(img)) {
      //@ts-ignore - createThumbnail not defined
      img = await game.video.createThumbnail(img, { width: 100, height: 100 });
    }

    let listItem = {
      isCharacter: actor.hasPlayerOwner,
      isNpc: !actor.hasPlayerOwner,
      actorUuid,
      tokenId: tokenId ?? "none",
      displayUuid: actorUuid.replaceAll(".", ""),
      tokenUuid,
      tokenImg: img,
      hpDamage,
      abshpDamage: Math.abs(hpDamage),
      tempDamage: newTempHP - oldTempHP,
      totalDamage: Math.abs(totalDamage),
      halfDamage: Math.abs(Math.floor(totalDamage / 2)),
      doubleDamage: Math.abs(totalDamage * 2),
      appliedDamage,
      playerViewTotalDamage: hpDamage + tempDamage,
      absDamage: Math.abs(appliedDamage),
      tokenName: (tokenDocument?.name && configSettings.useTokenNames) ? tokenDocument.name : actor.name,
      dmgSign: appliedDamage < 0 ? "+" : "-", // negative damage is added to hit points
      newHP,
      newTempHP,
      oldTempHP,
      oldHP,
      oldVitality,
      newVitality,
      buttonId: tokenUuid,
      iconPrefix: (data.autoApplyDamage === "yesCardNPC" && actor.type === "character") ? "*" : "",
      updateContext: data.updateContext
    };

    ["di", "dv", "dr"].forEach(trait => {
      const traits = actor?.system.traits[trait]
      if (traits.value instanceof Array && (traits?.custom || traits?.value.length > 0)) {
        //@ts-expect-error CONFIG.DND5E
        listItem[trait] = (`${traitList[trait]}: ${traits.value.map(t => CONFIG.DND5E.damageResistanceTypes[t]).join(",").concat(" " + traits?.custom)}`);
      } else if (traits.value instanceof Set && (traits?.custom || traits?.value.size > 0)) {
        const tl = traits.value.reduce((acc, v) => { acc.push(v); return acc }, [])
        listItem[trait] = (`${traitList[trait]}: ${tl.join(",").concat(" " + traits?.custom)}`);
      }
    });
    //@ts-ignore
    const actorFlags: any = actor.flags;
    const DRFlags = actorFlags["midi-qol"] ? actorFlags["midi-qol"].DR : undefined;
    if (DRFlags) {
      listItem["DR"] = "DR: ";
      for (let key of Object.keys(DRFlags)) {
        listItem["DR"] += `${key}:${DRFlags[key]} `;
      }
    }
    //@ts-ignore listItem
    templateData.damageList.push(listItem);
  }
  return promises;
}
// Fetch the token, then use the tokenData.actor.id
async function createPlayerDamageCard(data: { damageList: any; autoApplyDamage: string; flagTags: any, sender: string, charName: string, actorId: string, updateContext: any, forceApply: boolean }): Promise<string | undefined> {
  let shouldShow = true;
  let chatCardUuid;
  if (configSettings.playerCardDamageDifferent) {
    shouldShow = false;
    for (let damageItem of data.damageList) {
      if (damageItem.totalDamage !== damageItem.appliedDamage) shouldShow = true;
    }
  }
  if (!shouldShow) return;
  if (configSettings.playerDamageCard === "none") return;
  let showNPC = ["npcplayerresults", "npcplayerbuttons"].includes(configSettings.playerDamageCard);
  let playerButtons = ["playerbuttons", "npcplayerbuttons"].includes(configSettings.playerDamageCard);
  const damageList = data.damageList;
  //@ts-ignore
  let actor: CONFIG.Actor.documentClass; // { update: (arg0: { "system.attributes.hp.temp": any; "system.attributes.hp.value": number; "flags.dae.damageApplied": any; damageItem: any[] }) => Promise<any>; img: any; type: string; name: any; data: { data: { traits: { [x: string]: any; }; }; }; };
  const startTime = Date.now();
  let tokenIdList: any[] = [];
  let templateData = {
    damageApplied: ["yes", "yesCard", "yesCardMisses"].includes(data.autoApplyDamage) ? i18n("midi-qol.HPUpdated") : i18n("midi-qol.HPNotUpdated"),
    damageList: [],
    needsButtonAll: false,
    showNPC,
    playerButtons
  };

  prepareDamageListItems(data, templateData, tokenIdList, false, showNPC, true)
  if (templateData.damageList.length === 0) {
    log("No damage data to show to player");
    return;
  }

  templateData.needsButtonAll = damageList.length > 1;
  //@ts-ignore
  templateData.playerButtons = templateData.playerButtons && templateData.damageList.some(listItem => listItem.isCharacter)
  if (["yesCard", "noCard", "yesCardNPC", "yesCardMisses", "noCardMisses"].includes(data.autoApplyDamage)) {
    const content = await renderTemplate("modules/midi-qol/templates/damage-results-player.html", templateData);
    const speaker: any = ChatMessage.getSpeaker();
    speaker.alias = data.sender;
    let chatData: any = {
      user: game.user?.id,
      speaker: { scene: getCanvas()?.scene?.id, alias: data.charName, user: game.user?.id, actor: data.actorId },
      content: content,
      // whisper: ChatMessage.getWhisperRecipients("players").filter(u => u.active).map(u => u.id),
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      flags: { "midiqol": { "undoDamage": tokenIdList } }
    };
    if (data.flagTags) chatData.flags = mergeObject(chatData.flags ?? "", data.flagTags);
    chatCardUuid = (await ChatMessage.create(chatData))?.uuid;
  }
  log(`createPlayerReverseDamageCard elapsed: ${Date.now() - startTime}ms`)
  return chatCardUuid;
}

// Fetch the token, then use the tokenData.actor.id
async function createGMReverseDamageCard(
  data: { damageList: any; autoApplyDamage: string; flagTags: any, updateContext: any, forceApply: boolean },
  doHits: boolean = true): Promise<string | undefined> {
  const damageList = data.damageList;
  let actor: { update: (arg0: { "system.attributes.hp.temp": any; "system.attributes.hp.value": number; "flags.dae.damageApplied": any; damageItem: any[] }) => Promise<any>; img: any; type: string; name: any; data: { data: { traits: { [x: string]: any; }; }; }; };
  const startTime = Date.now();
  let promises: Array<Promise<any>>;;
  let tokenIdList: any[] = [];
  let chatCardUuid;
  const damageWasApplied = doHits && (["yes", "yesCard", "yesCardMisses"].includes(data.autoApplyDamage) || data.forceApply);
  let templateData = {
    damageWasApplied,
    damageApplied: damageWasApplied ? i18n("midi-qol.HPUpdated") : data.autoApplyDamage === "yesCardNPC" ? i18n("midi-qol.HPNPCUpdated") : i18n("midi-qol.HPNotUpdated"),
    damageList: [],
    needsButtonAll: false
  };
  promises = await prepareDamageListItems(data, templateData, tokenIdList, true, true, doHits)

  templateData.needsButtonAll = damageList.length > 1;

  //@ts-ignore
  const results = await Promise.allSettled(promises);
  if (debugEnabled > 0) warn("GM action results are ", results)
  if (["yesCard", "noCard", "yesCardNPC", "yesCardMisses", "noCardMisses"].includes(data.autoApplyDamage)) {
    const content = await renderTemplate("modules/midi-qol/templates/damage-results.html", templateData);
    const speaker: any = ChatMessage.getSpeaker();
    speaker.alias = game.user?.name;
    let chatData: any = {
      user: game.user?.id,
      speaker: { scene: getCanvas()?.scene?.id, alias: game.user?.name, user: game.user?.id },
      content: content,
      whisper: ChatMessage.getWhisperRecipients("GM").filter(u => u.active).map(u => u.id),
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      flags: { "midiqol": { "undoDamage": tokenIdList } }
    };
    if (data.flagTags) chatData.flags = mergeObject(chatData.flags ?? "", data.flagTags);
    chatCardUuid = (await ChatMessage.create(chatData))?.uuid;
  }
  log(`createGMReverseDamageCard elapsed: ${Date.now() - startTime}ms`);
  return chatCardUuid;
}

async function doClick(event: { stopPropagation: () => void; }, actorUuid: any, totalDamage: any, mult: any, data: any) {
  let actor = MQfromActorUuid(actorUuid);
  log(`Applying ${totalDamage} mult ${mult} HP to ${actor.name}`);
  await actor.applyDamage(totalDamage, mult);
  event.stopPropagation();
}

async function doMidiClick(ev: any, actorUuid: any, newTempHP: any, newHP: any, newVitality: number, mult: number, data: any) {
  let actor = MQfromActorUuid(actorUuid);
  log(`Setting HP to ${newTempHP} and ${newHP}`);
  let updateContext = mergeObject({ dhp: (newHP - actor.system.attributes.hp.value) }, data.updateContext);
  if (actor.isOwner) {
    const update = { "system.attributes.hp.temp": newTempHP, "system.attributes.hp.value": newHP };
    const vitalityResource = checkRule("vitalityResource");
    if (typeof vitalityResource === "string" && getProperty(actor, vitalityResource.trim()) !== undefined) {
      update[vitalityResource.trim()] = newVitality;
      const vitality = getProperty(actor, vitalityResource.trim()) ?? 0;
      updateContext["dvital"] = newVitality - vitality;
    }
    await actor?.update(update, updateContext);
  }
}

export let processUndoDamageCard = (message, html, data) => {
  if (!message.flags?.midiqol?.undoDamage) return true;
  let button = html.find("#all-reverse");

  button.click((ev: { stopPropagation: () => void; }) => {
    (async () => {
      for (let { actorUuid, oldTempHP, oldHP, totalDamage, newHP, newTempHP, oldVitality, newVitality, damageItem } of message.flags.midiqol.undoDamage) {
        //message.flags.midiqol.undoDamage.forEach(async ({ actorUuid, oldTempHP, oldHP, totalDamage, newHP, newTempHP, damageItem }) => {
        if (!actorUuid) continue;
        const applyButton = html.find(`#apply-${actorUuid.replaceAll(".", "")}`);
        applyButton.children()[0].classList.add("midi-qol-enable-damage-button");
        applyButton.children()[0].classList.remove("midi-qol-disable-damage-button");
        const reverseButton = html.find(`#reverse-${actorUuid.replaceAll(".", "")}`);
        reverseButton.children()[0].classList.remove("midi-qol-enable-damage-button");
        reverseButton.children()[0].classList.add("midi-qol-disable-damage-button");
        let actor = MQfromActorUuid(actorUuid);
        log(`Setting HP back to ${oldTempHP} and ${oldHP}`, actor);
        const update = { "system.attributes.hp.temp": oldTempHP ?? 0, "system.attributes.hp.value": oldHP ?? 0 };
        const context = { dhp: (oldHP ?? 0) - (actor.system.attributes.hp.value ?? 0), damageItem };
        const vitalityResource = checkRule("vitalityResource");
        if (typeof vitalityResource === "string" && getProperty(actor, vitalityResource.trim()) !== undefined) {
          update[vitalityResource.trim()] = oldVitality;
          context["dvital"] = oldVitality - newVitality;
        }
        await actor?.update(update, context);

        ev.stopPropagation();
      }
    })();
  });

  button = html.find("#all-apply");
  button.click((ev: { stopPropagation: () => void; }) => {
    (async () => {
      for (let { actorUuid, oldTempHP, oldHP, totalDamage, newHP, newTempHP, damageItem, oldVitality, newVitality } of message.flags.midiqol.undoDamage) {
        if (!actorUuid) continue;
        let actor = MQfromActorUuid(actorUuid);
        const applyButton = html.find(`#apply-${actorUuid.replaceAll(".", "")}`);
        applyButton.children()[0].classList.add("midi-qol-disable-damage-button");
        applyButton.children()[0].classList.remove("midi-qol-enable-damage-button");
        const reverseButton = html.find(`#reverse-${actorUuid.replaceAll(".", "")}`);
        reverseButton.children()[0].classList.remove("midi-qol-disable-damage-button");
        reverseButton.children()[0].classList.add("midi-qol-enable-damage-button");
        log(`Setting HP to ${newTempHP} and ${newHP}`);
        const update = { "system.attributes.hp.temp": newTempHP, "system.attributes.hp.value": newHP };
        const context = { dhp: newHP - actor.system.attributes.hp.value, damageItem };
        const vitalityResource = checkRule("vitalityResource");
        if (typeof vitalityResource === "string" && getProperty(actor, vitalityResource.trim()) !== undefined) {
          update[vitalityResource.trim()] = newVitality;
          context["dvital"] = oldVitality - newVitality;
        }
        if (actor.isOwner) await actor.update(update, context);
        ev.stopPropagation();
      }
    })();
  })

  message.flags.midiqol.undoDamage.forEach(({ actorUuid, oldTempHP, oldHP, totalDamage, newHP, newTempHP, oldVitality, newVitality, damageItem }) => {
    if (!actorUuid) return;
    // ids should not have "." in the or it's id.class
    let button = html.find(`#reverse-${actorUuid.replaceAll(".", "")}`);
    // button.click((ev: { stopPropagation: () => void; }) => {
    button.click((ev: { stopPropagation: () => void; currentTarget: any }) => {
      ev.currentTarget.children[0].classList.add("midi-qol-disable-damage-button");
      ev.currentTarget.children[0].classList.remove("midi-qol-enable-damage-button");
      const otherButton = html.find(`#apply-${actorUuid.replaceAll(".", "")}`);
      otherButton.children()[0].classList.remove("midi-qol-disable-damage-button");
      otherButton.children()[0].classList.add("midi-qol-enable-damage-button");
      (async () => {
        let actor = MQfromActorUuid(actorUuid);
        log(`Setting HP back to ${oldTempHP} and ${oldHP}`, data.updateContext);
        const update = { "system.attributes.hp.temp": oldTempHP ?? 0, "system.attributes.hp.value": oldHP ?? 0 };
        const context = { dhp: (oldHP ?? 0) - (actor.system.attributes.hp.value ?? 0), damageItem };
        const vitalityResource = checkRule("vitalityResource");
        if (typeof vitalityResource === "string" && getProperty(actor, vitalityResource.trim()) !== undefined) {
          update[vitalityResource.trim()] = oldVitality;
          context["dvital"] = newVitality - oldVitality;
        }
        if (actor.isOwner) await actor.update(update, context);
        ev.stopPropagation();
      })();
    });

    // Default action of button is to do midi damage
    button = html.find(`#apply-${actorUuid.replaceAll(".", "")}`);
    button.click((ev: { stopPropagation: () => void; currentTarget: any }) => {
      ev.currentTarget.children[0].classList.add("midi-qol-disable-damage-button");
      ev.currentTarget.children[0].classList.remove("midi-qol-enable-damage-button");
      const otherButton = html.find(`#reverse-${actorUuid.replaceAll(".", "")}`);
      otherButton.children()[0].classList.remove("midi-qol-disable-damage-button");
      otherButton.children()[0].classList.add("midi-qol-enable-damage-button");
      let multiplierString = html.find(`#dmg-multiplier-${actorUuid.replaceAll(".", "")}`).val();
      const mults = { "-1": -1, "x1": 1, "x0.25": 0.25, "x0.5": 0.5, "x2": 2 };
      let multiplier = 1;
      (async () => {
        let actor = MQfromActorUuid(actorUuid);
        log(`Setting HP to ${newTempHP} and ${newHP}`, data.updateContext);
        if (mults[multiplierString]) {
          multiplier = mults[multiplierString]
          await actor.applyDamage(totalDamage, multiplier);
        } else {
          const update = { "system.attributes.hp.temp": newTempHP, "system.attributes.hp.value": newHP };
          const context = { dhp: newHP - actor.system.attributes.hp.value, damageItem };
          const vitalityResource = checkRule("vitalityResource");
          if (typeof vitalityResource === "string" && getProperty(actor, vitalityResource.trim()) !== undefined) {
            update[vitalityResource.trim()] = newVitality;
            context["dvital"] = oldVitality - newVitality;
          }
          if (actor.isOwner) await actor.update(update, context);
        }
        ev.stopPropagation();
      })();
    });

    let select = html.find(`#dmg-multiplier-${actorUuid.replaceAll(".", "")}`);
    select.change((ev: any) => {
      return true;
      let multiplier = html.find(`#dmg-multiplier-${actorUuid.replaceAll(".", "")}`).val();
      button = html.find(`#apply-${actorUuid.replaceAll(".", "")}`);
      button.off('click');

      const mults = { "-1": -1, "x1": 1, "x0.25": 0.25, "x0.5": 0.5, "x2": 2 };
      if (multiplier === "calc")
        // button.click(async (ev: any) => await doMidiClick(ev, actorUuid, newTempHP, newHP, newVitality, 1, data));
        doMidiClick(ev, actorUuid, newTempHP, newHP, newVitality, 1, data);
      else if (mults[multiplier])
        // button.click(async (ev: any) => await doClick(ev, actorUuid, totalDamage, mults[multiplier], data));
        doClick(ev, actorUuid, totalDamage, mults[multiplier], data);
    });
  })
  return true;
}

async function _moveToken(data: { tokenUuid: string, newCenter: { x: number, y: number } }): Promise<any> {
  const token = MQfromUuid(data.tokenUuid);
  if (!token) return;
  return token.update({ x: data.newCenter?.x ?? 0, y: data.newCenter?.y ?? 0 });
}

async function _moveTokenAwayFromPoint(data: { targetUuid: string, point: { x: number, y: number }, distance: number }): Promise<void> {
  const targetToken = getToken(data.targetUuid);
  const targetTokenDocument = getTokenDocument(targetToken);
  if (!canvas || !canvas.dimensions || !canvas.grid || !targetToken || !data.point) return;
  let ray = new Ray(data.point, targetToken.center);
  let distance = data.distance / canvas.dimensions.distance * canvas.dimensions.size;
  let newCenter = ray.project(1 + distance / ray.distance);
  newCenter = canvas.grid.getSnappedPosition(newCenter.x - targetToken.w / 2, newCenter.y - targetToken.h / 2, 1);
  //@ts-expect-error
  return targetTokenDocument.update({ x: newCenter?.x ?? 0, y: newCenter?.y ?? 0 });
}
