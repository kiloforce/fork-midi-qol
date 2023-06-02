import { debug, i18n, error, warn, noDamageSaves, cleanSpellName, MQdefaultDamageType, allAttackTypes, gameStats, debugEnabled, overTimeEffectsToDelete, geti18nOptions, failedSaveOverTimeEffectsToDelete } from "../midi-qol.js";
import { configSettings, autoRemoveTargets, checkRule, lateTargeting, criticalDamage, criticalDamageGM } from "./settings.js";
import { log } from "../midi-qol.js";
import { BetterRollsWorkflow, DummyWorkflow, Workflow, WORKFLOWSTATES } from "./workflow.js";
import { socketlibSocket, timedAwaitExecuteAsGM } from "./GMAction.js";
import { dice3dEnabled, installedModules } from "./setupModules.js";
import { concentrationCheckItemDisplayName, itemJSONData, midiFlagTypes, overTimeJSONData } from "./Hooks.js";

import { OnUseMacros } from "./apps/Item.js";
import { actorAbilityRollPatching, Options } from "./patching.js";
import { isEmptyBindingElement } from "typescript";
import { activationConditionToUse } from "./itemhandling.js";

export function getDamageType(flavorString): string | undefined {
  const validDamageTypes = Object.entries(getSystemCONFIG().damageTypes).deepFlatten().concat(Object.entries(getSystemCONFIG().healingTypes).deepFlatten())
  const allDamageTypeEntries = Object.entries(getSystemCONFIG().damageTypes).concat(Object.entries(getSystemCONFIG().healingTypes));
  if (validDamageTypes.includes(flavorString)) {
    const damageEntry: any = allDamageTypeEntries?.find(e => e[1] === flavorString);
    return damageEntry ? damageEntry[0] : flavorString
  }
  return undefined;
}

export function getDamageFlavor(damageType): string | undefined {
  const validDamageTypes = Object.entries(getSystemCONFIG().damageTypes).deepFlatten().concat(Object.entries(getSystemCONFIG().healingTypes).deepFlatten())
  const allDamageTypeEntries = Object.entries(getSystemCONFIG().damageTypes).concat(Object.entries(getSystemCONFIG().healingTypes));
  if (validDamageTypes.includes(damageType)) {
    const damageEntry: any = allDamageTypeEntries?.find(e => e[0] === damageType);
    return damageEntry ? damageEntry[1] : damageType
  }
  return undefined;
}

/**
 *  return a list of {damage: number, type: string} for the roll and the item
 */
export function createDamageList({ roll, item, versatile, defaultType = MQdefaultDamageType, ammo }): { damage: unknown; type: string; }[] {
  let damageParts = {};
  const rollTerms = roll?.terms ?? [];;
  let evalString = "";
  let parts = duplicate(item?.system.damage.parts ?? []);
  if (versatile && item?.system.damage.versatile) {
    parts[0][0] = item.system.damage.versatile;
  }
  if (ammo) parts = parts.concat(ammo.system.damage.parts)

  // create data for a synthetic roll
  let rollData = item ? item.getRollData() : {};
  rollData.mod = 0;
  if (debugEnabled > 1) debug("CreateDamageList: Passed roll is ", roll)
  if (debugEnabled > 1) debug("CreateDamageList: Damage spec is ", parts)
  let partPos = 0;
  const validDamageTypes = Object.entries(getSystemCONFIG().damageTypes).deepFlatten().concat(Object.entries(getSystemCONFIG().healingTypes).deepFlatten())
  const allDamageTypeEntries = Object.entries(getSystemCONFIG().damageTypes).concat(Object.entries(getSystemCONFIG().healingTypes));

  // If we have an item we can use it to work out each of the damage lines that are being rolled
  for (let [spec, type] of parts) { // each spec,type is one of the damage lines
    if (partPos >= rollTerms.length) continue;
    // TODO look at replacing this with a map/reduce
    if (debugEnabled > 1) debug("CreateDamageList: single Spec is ", spec, type, item)
    let formula = Roll.replaceFormulaData(spec, rollData, { missing: "0", warn: false });
    // However will be a problem longer term when async not supported?? What to do
    let dmgSpec: Roll | undefined;
    try {
      // TODO Check if we actually have to to do the roll - intermeidate terms and simplifying the roll are the two bits to think about
      dmgSpec = new Roll(formula, rollData).evaluate({ async: false });
    } catch (err) {
      console.warn("midi-qol | Dmg spec not valid", formula)
      dmgSpec = undefined;
      break;
    }
    if (!dmgSpec || dmgSpec.terms?.length < 1) break;
    // dmgSpec is now a roll with the right terms (but nonsense value) to pick off the right terms from the passed roll
    // Because damage spec is rolled it drops the leading operator terms, so do that as well
    for (let i = 0; i < dmgSpec.terms.length; i++) { // grab all the terms for the current damage line
      // rolls can have extra operator terms if mods are negative so test is
      // if the current roll term is an operator but the next damage spec term is not 
      // add the operator term to the eval string and advance the roll term counter
      // eventually rollTerms[partPos] will become undefined so it can't run forever
      while (rollTerms[partPos] instanceof CONFIG.Dice.termTypes.OperatorTerm &&
        !(dmgSpec.terms[i] instanceof CONFIG.Dice.termTypes.OperatorTerm)) {
        evalString += rollTerms[partPos].operator + " ";
        partPos += 1;
      }
      if (rollTerms[partPos]) {
        const hasDivideMultiply = rollTerms[partPos + 1] instanceof OperatorTerm && ["/", "*"].includes(rollTerms[partPos + 1].operator);
        if (rollTerms[partPos] instanceof OperatorTerm) {
          evalString += rollTerms[partPos].operator + " ";
        }

        if (rollTerms[partPos] instanceof DiceTerm || rollTerms[partPos] instanceof NumericTerm) {
          const flavorDamageType = getDamageType(rollTerms[partPos]?.options?.flavor);
          type = flavorDamageType ?? type;
          if (!rollTerms[partPos]?.options.flavor) {
            setProperty(rollTerms[partPos].options, "flavor", getDamageFlavor(type));
          }

          evalString += rollTerms[partPos]?.total;
          if (!hasDivideMultiply) {
            // let result = Roll.safeEval(evalString);
            let result = new Roll(evalString).evaluate({ async: false }).total;
            damageParts[type || defaultType] = (damageParts[type || defaultType] || 0) + result;
            evalString = "";
          }
        }
        if (rollTerms[partPos] instanceof PoolTerm) {
          const flavorDamageType = getDamageType(rollTerms[partPos]?.options?.flavor);
          type = flavorDamageType ?? type;
          if (!rollTerms[partPos]?.options.flavor) {
            setProperty(rollTerms[partPos].options, "flavor", getDamageFlavor(type));
          }
          evalString += rollTerms[partPos]?.total;
        }
      }
      partPos += 1;
    }
    // Each damage line is added together and we can skip the operator term
    partPos += 1;
    if (evalString !== "") {
      // let result = Roll.safeEval(evalString);
      let result = new Roll(evalString).evaluate({ async: false }).total;
      damageParts[type || defaultType] = (damageParts[type || defaultType] || 0) + result;
      evalString = "";
    }
  }
  // We now have all of the item's damage lines (or none if no item)
  // Now just add up the other terms - using any flavor types for the rolls we get
  // we stepped one term too far so step back one
  partPos = Math.max(0, partPos - 1);

  // process the rest of the roll as a sequence of terms.
  // Each might have a damage flavour so we do them expression by expression

  evalString = "";
  let damageType: string | undefined = defaultType;
  let numberTermFound = false; // We won't evaluate until at least 1 numeric term is found
  while (partPos < rollTerms.length) {
    // Accumulate the text for each of the terms until we have enough to eval
    const evalTerm = rollTerms[partPos];
    partPos += 1;
    if (evalTerm instanceof DiceTerm) {
      // this is a dice roll
      damageType = getDamageType(evalTerm.options?.flavor) ?? damageType;
      if (!evalTerm?.options.flavor) {
        setProperty(evalTerm, "options.flavor", getDamageFlavor(damageType));
      }
      numberTermFound = true;
      evalString += evalTerm.total;
    } else if (evalTerm instanceof Die) { // special case for better rolls that does not return a proper roll
      damageType = getDamageType(evalTerm.options?.flavor) ?? damageType;
      if (!evalTerm?.options.flavor) {
        setProperty(evalTerm, "options.flavor", getDamageFlavor(damageType));
      }
      numberTermFound = true;
      evalString += evalTerm.total;
    } else if (evalTerm instanceof NumericTerm) {
      damageType = getDamageType(evalTerm.options?.flavor) ?? damageType;
      if (!evalTerm?.options.flavor) {
        setProperty(evalTerm, "options.flavor", getDamageFlavor(damageType));
      }
      numberTermFound = true;
      evalString += evalTerm.total;
    }
    if (evalTerm instanceof PoolTerm) {
      damageType = getDamageType(evalTerm?.options?.flavor) ?? damageType;
      if (!evalTerm?.options.flavor) {
        setProperty(evalTerm, "options.flavor", getDamageFlavor(damageType));
      }
      evalString += evalTerm.total;
    }
    if (evalTerm instanceof OperatorTerm) {
      if (["*", "/"].includes(evalTerm.operator)) {
        // multiply or divide keep going
        evalString += evalTerm.total
      } else if (["-", "+"].includes(evalTerm.operator)) {
        if (numberTermFound) { // we have a number and a +/- so we can eval the term (do it straight away so we get the right damage type)
          let result = Roll.safeEval(evalString);
          damageParts[damageType || defaultType] = (damageParts[damageType || defaultType] || 0) + result;
          // reset for the next term - we don't know how many there will be
          evalString = "";
          damageType = defaultType;
          numberTermFound = false;
          evalString = evalTerm.operator;
        } else { // what to do with parenthetical term or others?
          evalString += evalTerm.total;
        }
      }
    }
  }
  // evalString contains the terms we have not yet evaluated so do them now

  if (evalString) {
    const damage = Roll.safeEval(evalString);
    // we can always add since the +/- will be recorded in the evalString
    damageParts[damageType || defaultType] = (damageParts[damageType || defaultType] || 0) + damage;
  }
  const damageList = Object.entries(damageParts).map(([type, damage]) => { return { damage, type } });
  if (debugEnabled > 1) debug("CreateDamageList: Final damage list is ", damageList);
  return damageList;
}

export function getSelfTarget(actor): Token {
  if (actor.token) return actor.token.object; //actor.token is a token document.
  const token = tokenForActor(actor);
  if (token) return token;
  const tokenData = actor.prototypeToken.toObject();
  tokenData.actorId = actor.id;
  const cls = getDocumentClass("Token");
  //@ts-expect-error
  return new cls(tokenData, { actor });
}

export function getSelfTargetSet(actor): Set<Token> {
  const selfTarget = getSelfTarget(actor);
  if (selfTarget) return new Set([selfTarget]);
  return new Set();
}

// Calculate the hp/tempHP lost for an amount of damage of type
export function calculateDamage(a: Actor, appliedDamage, t: Token, totalDamage, dmgType, existingDamage) {
  if (debugEnabled > 1) debug("calculate damage ", a, appliedDamage, t, totalDamage, dmgType)
  let prevDamage = existingDamage?.find(ed => ed.tokenId === t.id);
  //@ts-ignore attributes
  var hp = a.system.attributes.hp;
  var oldHP, tmp, oldVitality, newVitality;
  const resource = checkRule("vitalityResource");
  if (hp.value <= 0 && resource) {
    // Damage done to vitality rather than hp
    oldVitality = getProperty(a, resource.trim());
    newVitality = Math.max(0, oldVitality - appliedDamage);
  }
  if (prevDamage) {
    oldHP = prevDamage.newHP;
    tmp = prevDamage.newTempHP;
  } else {
    oldHP = hp.value;
    tmp = parseInt(hp.temp) || 0;
  }
  let value = Math.floor(appliedDamage);
  if (dmgType.includes("temphp")) { // only relevent for healing of tmp HP
    var newTemp = Math.max(tmp, -value, 0);
    var newHP: number = oldHP;
  } else {
    var dt = value > 0 ? Math.min(tmp, value) : 0;
    var newTemp = tmp - dt;
    var newHP: number = Math.clamped(oldHP - (value - dt), 0, hp.max + (parseInt(hp.tempmax) || 0));
  }
  //TODO review this awfulness
  // Stumble around trying to find the actual token that corresponds to the multi level token TODO make this sane
  //@ts-ignore .flags v10  
  const altSceneId = getProperty(t.flags, "multilevel-tokens.sscene");
  let sceneId = altSceneId ?? t.scene?.id;
  //@ts-ignore .flags v10
  const altTokenId = getProperty(t.flags, "multilevel-tokens.stoken");
  let tokenId = altTokenId ?? t.id;
  const altTokenUuid = (altTokenId && altSceneId) ? `Scene.${altSceneId}.Token.${altTokenId}` : undefined;
  let tokenUuid = altTokenUuid; // TODO this is nasty fix it.
  if (!tokenUuid && t.document) tokenUuid = t.document.uuid;

  if (debugEnabled > 1) debug("calculateDamage: results are ", newTemp, newHP, appliedDamage, totalDamage)
  if (game.user?.isGM)
    log(`${a.name} ${oldHP} takes ${value} reduced from ${totalDamage} Temp HP ${newTemp} HP ${newHP} `);
  // TODO change tokenId, actorId to tokenUuid and actor.uuid
  return {
    tokenId, tokenUuid, actorId: a.id, actorUuid: a.uuid, tempDamage: tmp - newTemp, hpDamage: oldHP - newHP, oldTempHP: tmp, newTempHP: newTemp,
    oldHP: oldHP, newHP: newHP, totalDamage: totalDamage, appliedDamage: value, sceneId, oldVitality, newVitality
  };
}

/** 
 * Work out the appropriate multiplier for DamageTypeString on actor
 * If configSettings.damageImmunities are not being checked always return 1
 * 
 */

export let getTraitMult = (actor, dmgTypeString, item): number => {
  dmgTypeString = dmgTypeString.toLowerCase();
  let totalMult = 1;
  if (dmgTypeString.includes("healing") || dmgTypeString.includes("temphp")) totalMult = -1;
  if (dmgTypeString.includes("midi-none")) return 0;
  if (configSettings.damageImmunities === "none") return totalMult;
  const phsyicalDamageTypes = Object.keys(getSystemCONFIG().physicalDamageTypes);

  if (dmgTypeString !== "") {
    // if not checking all damage counts as magical
    let magicalDamage = item?.system.properties?.mgc || item?.flags.midiProperties?.magicdam;
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.system.attackBonus > 0);
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.type !== "weapon");
    magicalDamage = magicalDamage || (configSettings.requireMagical === "nonspell" && item?.type === "spell");
    const silverDamage = item?.system.properties?.sil || magicalDamage;
    const adamantineDamage = item?.system.properties?.ada;
    const physicalDamage = phsyicalDamageTypes.includes(dmgTypeString);

    let traitList = [
      { type: "di", mult: configSettings.damageImmunityMultiplier },
      { type: "dr", mult: configSettings.damageResistanceMultiplier },
      { type: "dv", mult: configSettings.damageVulnerabilityMultiplier }];
    // for sw5e use sdi/sdr/sdv instead of di/dr/dv
    if (game.system.id === "sw5e" && actor.type === "starship" && actor.system.attributes.hp.tenp > 0) {
      traitList = [{ type: "sdi", mult: 0 }, { type: "sdr", mult: configSettings.damageResistanceMultiplier }, { type: "sdv", mult: configSettings.damageVulnerabilityMultiplier }];
    }
    for (let { type, mult } of traitList) {
      let trait = deepClone(actor.system.traits[type].value);
      let customs: string[] = [];
      if (actor.system.traits[type].custom?.length > 0) {
        customs = actor.system.traits[type].custom.split(";").map(s => s.trim())
      }
      // process new bypasses settings
      //@ts-expect-error
      if (isNewerVersion(game.system.version, "2.0.3")) {
        const bypasses = actor.system.traits[type].bypasses ?? new Set();
        if (magicalDamage && physicalDamage && bypasses.has("mgc")) continue; // magical damage bypass of trait.
        if (adamantineDamage && physicalDamage && bypasses.has("ada")) continue;
        if (silverDamage && physicalDamage && bypasses.has("sil")) continue;
        // process new custom field versions
        if (!["healing", "temphp"].includes(dmgTypeString)) {
          if (customs.includes(dmgTypeString)) {
            totalMult = totalMult * mult;
            continue;
          }
          if (!magicalDamage && (trait.has("nonmagic") || customs.includes(getSystemCONFIG().damageResistanceTypes["nonmagic"]))) {
            totalMult = totalMult * mult;
            continue;
          } else if (magicalDamage && trait.has("magic")) {
            totalMult = totalMult * mult;
            continue;
          }
          else if (item?.type === "spell" && trait.has("spell")) {
            totalMult = totalMult * mult;
            continue;
          } else if (item?.type === "power" && trait.has("power")) {
            totalMult = totalMult * mult;
            continue;
          }
          if (customs.length > 0) {
            if (!magicalDamage && (customs.includes("nonmagic") || customs.includes(getSystemCONFIG().damageResistanceTypes["nonmagic"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (magicalDamage && (customs.includes("magic") || customs.includes(getSystemCONFIG().damageResistanceTypes["magic"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (item?.type === "spell" && (customs.includes("spell") || customs.includes(getSystemCONFIG().damageResistanceTypes["spell"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (item?.type === "power" && (customs.includes("power") || customs.includes(getSystemCONFIG().damageResistanceTypes["power"]))) {
              totalMult = totalMult * mult;
              continue;
            }
          }
        }

        // Support old style leftover settings
        if (configSettings.damageImmunities === "immunityPhysical") {
          if (!magicalDamage && trait.has("physical"))
            phsyicalDamageTypes.forEach(dt => trait.add(dt))
          if (!(magicalDamage || silverDamage) && trait.has("silver"))
            phsyicalDamageTypes.forEach(dt => trait.add(dt))
          if (!(magicalDamage || adamantineDamage) && trait.has("adamant"))
            phsyicalDamageTypes.forEach(dt => trait.add(dt))
        }

        if (trait.has(dmgTypeString))
          totalMult = totalMult * mult;
      } else {
        const bypasses = actor.system.traits[type].bypasses ?? [];
        if (magicalDamage && physicalDamage && bypasses.includes("mgc")) continue; // magical damage bypass of trait.
        if (adamantineDamage && physicalDamage && bypasses.includes("ada")) continue;
        if (silverDamage && physicalDamage && bypasses.includes("sil")) continue;
        // process new custom field versions
        if (!["healing", "temphp"].includes(dmgTypeString)) {
          if (customs.includes(dmgTypeString)) {
            totalMult = totalMult * mult;
            continue;
          }
          if (!magicalDamage && (trait.includes("nonmagic") || customs.includes(getSystemCONFIG().damageResistanceTypes["nonmagic"]))) {
            totalMult = totalMult * mult;
            continue;
          } else if (magicalDamage && trait.includes("magic")) {
            totalMult = totalMult * mult;
            continue;
          }
          else if (item?.type === "spell" && trait.includes("spell")) {
            totalMult = totalMult * mult;
            continue;
          } else if (item?.type === "power" && trait.includes("power")) {
            totalMult = totalMult * mult;
            continue;
          }
          if (customs.length > 0) {
            if (!magicalDamage && (customs.includes("nonmagic") || customs.includes(getSystemCONFIG().damageResistanceTypes["nonmagic"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (magicalDamage && (customs.includes("magic") || customs.includes(getSystemCONFIG().damageResistanceTypes["magic"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (item?.type === "spell" && (customs.includes("spell") || customs.includes(getSystemCONFIG().damageResistanceTypes["spell"]))) {
              totalMult = totalMult * mult;
              continue;
            } else if (item?.type === "power" && (customs.includes("power") || customs.includes(getSystemCONFIG().damageResistanceTypes["power"]))) {
              totalMult = totalMult * mult;
              continue;
            }
          }
        }

        // Support old style leftover settings
        if (configSettings.damageImmunities === "immunityPhysical") {
          if (!magicalDamage && trait.includes("physical"))
            trait = trait.concat(phsyicalDamageTypes)
          if (!(magicalDamage || silverDamage) && trait.includes("silver"))
            trait = trait.concat(phsyicalDamageTypes)
          if (!(magicalDamage || adamantineDamage) && trait.includes("adamant"))
            trait = trait.concat(phsyicalDamageTypes)
        }

        if (trait.includes(dmgTypeString))
          totalMult = totalMult * mult;
      }
    }
  }
  return totalMult;
  // Check the custom immunities
}

export async function applyTokenDamage(damageDetail, totalDamage, theTargets, item, saves,
  options: any = { existingDamage: [], superSavers: new Set(), semiSuperSavers: new Set(), workflow: undefined, updateContext: undefined, forceApply: false }): Promise<any[]> {
  return legacyApplyTokenDamageMany([damageDetail], [totalDamage], theTargets, item, [saves], {
    existingDamage: options.existingDamage,
    superSavers: options.superSavers ? [options.superSavers] : [],
    semiSuperSavers: options.semiSuperSavers ? [options.semiSuperSavers] : [],
    workflow: options.workflow,
    updateContext: options.updateContext,
    forceApply: options.forceApply ?? true
  });
}

export interface applyDamageDetails {
  label: string;
  damageDetail: any[];
  damageTotal: number;
  saves?: Set<Token | TokenDocument>;
  superSavers?: Set<Token | TokenDocument>;
  semiSuperSavers?: Set<Token | TokenDocument>;
}

export async function applyTokenDamageMany({ applyDamageDetails, theTargets, item,
  options = { existingDamage: [], workflow: undefined, updateContext: undefined, forceApply: false } }:
  { applyDamageDetails: applyDamageDetails[]; theTargets: Set<Token | TokenDocument>; item: any; options?: { existingDamage: any[][]; workflow: Workflow | undefined; updateContext: any | undefined; forceApply: boolean }; }): Promise<any[]> {
  let damageList: any[] = [];
  let targetNames: string[] = [];
  let appliedDamage;
  let workflow: any = options.workflow ?? {};
  if (debugEnabled > 0) warn("Apply token damage ", applyDamageDetails, theTargets, item, workflow)
  if (!theTargets || theTargets.size === 0) {
    workflow.currentState = WORKFLOWSTATES.ROLLFINISHED;
    // probably called from refresh - don't do anything
    return [];
  }
  if (!(item instanceof CONFIG.Item.documentClass)) {
    if (workflow.item) item = workflow.item;
    else if (item?.uuid) {
      item = MQfromUuid(item.uuid);
    } else if (item) {
      error("ApplyTokenDamage item must be of type Item or null/undefined");
      return [];
    }
  }
  if (item && !options.workflow) workflow = Workflow.getWorkflow(item.uuid) ?? {};
  const damageDetailArr = applyDamageDetails.map(a => a.damageDetail);
  const highestOnlyDR = false;
  let totalDamage = applyDamageDetails.reduce((a, b) => a + (b.damageTotal ?? 0), 0);
  let totalAppliedDamage = 0;
  let appliedTempHP = 0;
  const itemSaveMultiplier = getSaveMultiplierForItem(item);
  for (let t of theTargets) {
    //@ts-ignore
    const targetToken: Token = (t instanceof TokenDocument ? t.object : t) ?? t;
    //@ts-ignore
    const targetTokenDocument: TokenDocument = t instanceof TokenDocument ? t : t.document;

    if (!targetTokenDocument || !targetTokenDocument.actor) continue;
    let targetActor: any = targetTokenDocument.actor;

    appliedDamage = 0;
    appliedTempHP = 0;
    let DRAll = 0;
    // damage absorption:
    const absorptions = getProperty(targetActor.flags, "midi-qol.absorption") ?? {};

    const firstDamageHealing = applyDamageDetails[0].damageDetail && ["healing", "temphp"].includes(applyDamageDetails[0].damageDetail[0]?.type);
    const isHealing = ("heal" === workflow.item?.system.actionType) || firstDamageHealing;
    const noDamageReactions = (item?.hasSave && item.flags?.midiProperties?.nodam && workflow?.saves?.has(t));
    const noProvokeReaction = getProperty(workflow.item, "flags.midi-qol.noProvokeReaction");

    //@ts-expect-error isEmpty
    if (totalDamage > 0 && !isEmpty(workflow) && !isHealing && !noDamageReactions && !noProvokeReaction && [Workflow, BetterRollsWorkflow].includes(workflow.constructor)) {
      // TODO check that the targetToken is actually taking damage
      // Consider checking the save multiplier for the item as a first step
      let result = await doReactions(targetToken, workflow.tokenUuid, workflow.damageRoll, "reactiondamage", { item: workflow.item, workflow, workflowOptions: { damageDetail: workflow.damageDetail, damageTotal: totalDamage, sourceActorUuid: workflow.actor?.uuid, sourceItemUuid: workflow.item?.uuid, sourceAmmoUuid: workflow.ammo?.uuid } });
    }
    const uncannyDodge = getProperty(targetActor, "flags.midi-qol.uncanny-dodge") && workflow.item?.hasAttack;
    if (game.system.id === "sw5e" && targetActor?.type === "starship") {
      // Starship damage r esistance applies only to attacks
      if (item && ["mwak", "rwak"].includes(item?.system.actionType)) {
        // This should be a roll?
        DRAll = getProperty(t, "actor.system.attributes.equip.armor.dr") ?? 0;;
      }
    } else if (getProperty(targetActor, "flags.midi-qol.DR.all") !== undefined)
      DRAll = (new Roll((`${getProperty(targetActor, "flags.midi-qol.DR.all") || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
    if (item?.hasAttack && getProperty(targetActor, `flags.midi-qol.DR.${item?.system.actionType}`)) {
      DRAll += (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.${item?.system.actionType}`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
    }
    // const magicalDamage = (item?.type !== "weapon" || item?.system.attackBonus > 0 || item?.system.properties["mgc"]);
    let magicalDamage = item?.system.properties?.mgc || item?.flags?.midiProperties?.magicdam;
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.system.attackBonus > 0);
    magicalDamage = magicalDamage || (configSettings.requireMagical === "off" && item?.type !== "weapon");
    magicalDamage = magicalDamage || (configSettings.requireMagical === "nonspell" && item?.type === "spell");

    const silverDamage = magicalDamage || (item?.type === "weapon" && item?.system.properties["sil"]);
    const adamantineDamage = item?.system.properties?.ada;

    let AR = 0; // Armor reduction for challenge mode armor etc.
    const ac = targetActor.system.attributes.ac;
    let damageDetail;
    let damageDetailResolved: any[] = [];
    for (let i = 0; i < applyDamageDetails.length; i++) {
      if (workflow.activationFails?.has(targetTokenDocument.uuid) && applyDamageDetails[i].label === "otherDamage") continue; // don't apply other damage is activationFails includes the token
      damageDetail = duplicate(applyDamageDetails[i].damageDetail ?? []);
      let attackRoll = workflow.attackTotal;
      let saves = applyDamageDetails[i].saves ?? new Set();
      let superSavers: Set<Token | TokenDocument> = applyDamageDetails[i].superSavers ?? new Set();
      let semiSuperSavers: Set<Token | TokenDocument> = applyDamageDetails[i].semiSuperSavers ?? new Set();
      var dmgType;

      // This is overall Damage Reduction
      let maxDR = Number.NEGATIVE_INFINITY;
      ;

      if (checkRule("challengeModeArmor") && checkRule("challengeModeArmorScale")) {
        AR = workflow.isCritical ? 0 : ac.AR;
      } else if (checkRule("challengeModeArmor") && attackRoll) {
        AR = ac.AR;
      } else AR = 0;
      let maxDRIndex = -1;

      for (let [index, damageDetailItem] of damageDetail.entries()) {
        if (checkRule("challengeModeArmor") && checkRule("challengeModeArmorScale") && attackRoll && workflow.hitTargetsEC?.has(t)) {
          //scale te damage detail for a glancing blow - only for the first damage list? or all?
          const scale = getProperty(targetActor, "flags.midi-qol.challengeModeScale");
          damageDetailItem.damage *= scale;
        }
      }
      let nonMagicalDRUsed = false;
      let nonMagicalPysicalDRUsed = false;
      let nonPhysicalDRUsed = false;
      let nonSilverDRUsed = false;
      let nonAdamantineDRUsed = false;
      let physicalDRUsed = false;

      // Calculate the Damage Reductions for each damage type
      for (let [index, damageDetailItem] of damageDetail.entries()) {
        let { damage, type } = damageDetailItem;
        type = type ?? MQdefaultDamageType;
        const physicalDamage = ["bludgeoning", "slashing", "piercing"].includes(type);

        if (absorptions[type] && absorptions[type] !== false) {
          const abMult = Number.isNumeric(absorptions[type]) ? Number(absorptions[type]) : 1;
          damageDetailItem.damage = damageDetailItem.damage * abMult;
          type = "healing";
          damageDetailItem.type = "healing"
        }
        let DRType = 0;
        if (type.toLowerCase() !== "temphp") dmgType = type.toLowerCase();
        // Pick the highest DR applicable to the damage type being inflicted.
        if (getProperty(targetActor, `flags.midi-qol.DR.${type}`)) {
          DRType = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.${type}`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DRType < 0) {
            damageDetailItem.damage -= DRType;
            DRType = 0;
          }
        }
        if (!nonMagicalPysicalDRUsed && physicalDamage && !magicalDamage && getProperty(targetActor, `flags.midi-qol.DR.non-magical-physical`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-magical-physical`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonMagicalPysicalDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!nonMagicalDRUsed && !magicalDamage && getProperty(targetActor, `flags.midi-qol.DR.non-magical`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-magical`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonMagicalDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!nonSilverDRUsed && physicalDamage && !silverDamage && getProperty(targetActor, `flags.midi-qol.DR.non-silver`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-silver`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonSilverDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!nonAdamantineDRUsed && physicalDamage && !adamantineDamage && getProperty(targetActor, `flags.midi-qol.DR.non-adamant`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-adamant`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonAdamantineDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!physicalDRUsed && physicalDamage && getProperty(targetActor, `flags.midi-qol.DR.physical`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.physical`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            physicalDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        if (!nonPhysicalDRUsed && !physicalDamage && getProperty(targetActor, `flags.midi-qol.DR.non-physical`)) {
          const DR = (new Roll((`${getProperty(targetActor, `flags.midi-qol.DR.non-physical`) || "0"}`), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
          if (DR < 0) {
            damageDetailItem.damage -= DR;
          } else {
            nonPhysicalDRUsed = DR > DRType;
            DRType = Math.max(DRType, DR);
          }
        }
        DRType = Math.min(damage, DRType);
        // We have the DRType for the current damage type
        if (DRType >= maxDR) {
          maxDR = DRType;
          maxDRIndex = index;
        }
        damageDetailItem.DR = DRType;
      }

      if (DRAll > 0 && DRAll < maxDR && checkRule("maxDRValue")) DRAll = 0;
      let DRAllRemaining = Math.max(DRAll, 0);
      // Now apportion DRAll to each damage type if required
      for (let [index, damageDetailItem] of damageDetail.entries()) {
        let { damage, type, DR } = damageDetailItem;
        if (checkRule("maxDRValue")) {
          if (index !== maxDRIndex) {
            damageDetailItem.DR = 0;
            DR = 0;
          } else if (DRAll > maxDR) {
            damageDetailItem.DR = 0;
            DR = 0;
          }
        }
        if (DR < damage && DRAllRemaining > 0 && !["healing", "temphp"].includes(damageDetailItem.type)) {
          damageDetailItem.DR = Math.min(damage, DR + DRAllRemaining);
          DRAllRemaining = Math.max(0, DRAllRemaining + DR - damage);
        }
        // Apply AR here
      }

      for (let [index, damageDetailItem] of damageDetail.entries()) {
        let { damage, type, DR } = damageDetailItem;
        if (!type) type = MQdefaultDamageType;

        let mult = saves.has(t) ? itemSaveMultiplier : 1;
        if (superSavers.has(t) && itemSaveMultiplier === 0.5) {
          mult = saves.has(t) ? 0 : 0.5;
        }
        if (semiSuperSavers.has(t) && itemSaveMultiplier === 0.5)
          mult = saves.has(t) ? 0 : 1;

        if (uncannyDodge) mult = mult / 2;

        const resMult = getTraitMult(targetActor, type, item);
        mult = mult * resMult;
        damageDetailItem.damageMultiplier = mult;
        /*
        if (!["healing", "temphp"].includes(type)) damage -= DR; // Damage reduction does not apply to healing
        */
        damage -= DR;
        let typeDamage = Math.floor(damage * Math.abs(mult)) * Math.sign(mult);
        let typeDamageUnRounded = damage * mult;

        if (type.includes("temphp")) {
          appliedTempHP += typeDamage
        } else {
          appliedDamage += typeDamageUnRounded;
        }

        // TODO: consider mwak damage reduction - we have the workflow so should be possible
      }
      damageDetailResolved = damageDetailResolved.concat(damageDetail);
      if (debugEnabled > 0) console.warn("midi-qol | Damage Details plus resistance/save multiplier for ", targetActor.name, duplicate(damageDetail))
    }
    if (DRAll < 0 && appliedDamage > -1) { // negative DR is extra damage
      damageDetailResolved = damageDetailResolved.concat({ damage: -DRAll, type: "DR", DR: 0 });
      appliedDamage -= DRAll;
      totalDamage -= DRAll;
    }
    if (false && !Object.keys(getSystemCONFIG().healingTypes).includes(dmgType)) {
      totalDamage = Math.max(totalDamage, 0);
      appliedDamage = Math.max(appliedDamage, 0);
    }
    //@ts-ignore
    if (AR > 0 && appliedDamage > 0 && !Object.keys(getSystemCONFIG().healingTypes).includes(dmgType) && checkRule("challengeModeArmor")) {
      totalDamage = appliedDamage;
      if (checkRule("challengeModeArmorScale") || workflow.hitTargetsEC.has(t)) // TODO: the hitTargetsEC test won't ever fire?
        appliedDamage = Math.max(0, appliedDamage - AR)
    }

    totalAppliedDamage += appliedDamage;
    if (!dmgType) dmgType = "temphp";
    if (!["healing", "temphp"].includes(dmgType) && getProperty(targetActor, `flags.midi-qol.DR.final`)) {
      let DRType = (new Roll((getProperty(targetActor, `flags.midi-qol.DR.final`) || "0"), targetActor.getRollData())).evaluate({ async: false }).total ?? 0;
      appliedDamage = Math.max(0, appliedDamage - DRType)
    }

    // Deal with vehicle damage threshold.
    if (appliedDamage > 0 && appliedDamage < (targetActor.system.attributes.hp.dt ?? 0)) appliedDamage = 0;
    let ditem: any = calculateDamage(targetActor, appliedDamage, targetToken, totalDamage, dmgType, options.existingDamage);
    ditem.tempDamage = ditem.tempDamage + appliedTempHP;
    if (appliedTempHP <= 0) { // temp healing applied to actor does not add only gets the max
      ditem.newTempHP = Math.max(ditem.newTempHP, -appliedTempHP);
    } else {
      ditem.newTempHP = Math.max(0, ditem.newTempHP - appliedTempHP)
    }
    ditem.damageDetail = duplicate(damageDetailArr);
    ditem.critical = workflow?.isCritical;
    await asyncHooksCallAll("midi-qol.damageApplied", t, { item, workflow, damageItem: ditem, ditem });
    //@ts-expect-error isEmtpy
    if (!isEmpty(workflow) && configSettings.allowUseMacro && workflow.item?.flags) {
      workflow.damageItem = ditem;
      await workflow.triggerTargetMacros(["preTargetDamageApplication"], [t]);
      ditem = workflow.damageItem;
      delete workflow.damageItem
    }
    damageList.push(ditem);
    targetNames.push(t.name)
  }
  if (theTargets.size > 0) {
    workflow.damageList = damageList;
    //@ts-expect-error isEmpty
    if (!isEmpty(workflow) && configSettings.allowUseMacro && workflow.item?.flags) {
      await workflow.callMacros(workflow.item, workflow.onUseMacros?.getMacros("preDamageApplication"), "OnUse", "preDamageApplication");
    }

    const chatCardUuids = await timedAwaitExecuteAsGM("createReverseDamageCard", {
      autoApplyDamage: configSettings.autoApplyDamage,
      sender: game.user?.name,
      actorId: workflow.actor?.id,
      charName: workflow.actor?.name ?? game?.user?.name,
      damageList: damageList,
      targetNames,
      chatCardId: workflow.itemCardId,
      flagTags: workflow.flagTags,
      updateContext: options?.updateContext,
      forceApply: options.forceApply,
    })
    if (workflow && configSettings.undoWorkflow) {
      // Assumes workflow.undoData.chatCardUuids has been initialised
      if (workflow.undoData) {
        workflow.undoData.chatCardUuids = workflow.undoData.chatCardUuids.concat(chatCardUuids);
        socketlibSocket.executeAsGM("updateUndoChatCardUuids", workflow.undoData);
      }
    }
  }
  if (configSettings.keepRollStats) {
    gameStats.addDamage(totalAppliedDamage, totalDamage, theTargets.size, item)
  }
  return damageList;
};

export async function legacyApplyTokenDamageMany(damageDetailArr, totalDamageArr, theTargets, item, savesArr,
  options: { existingDamage: any[][], superSavers: Set<any>[], semiSuperSavers: Set<any>[], workflow: Workflow | undefined, updateContext: any, forceApply: any }
    = { existingDamage: [], superSavers: [], semiSuperSavers: [], workflow: undefined, updateContext: undefined, forceApply: false }): Promise<any[]> {
  const mappedDamageDetailArray: applyDamageDetails[] = damageDetailArr.map((dd, i) => {
    return {
      label: "test",
      damageDetail: dd,
      damageTotal: totalDamageArr[i],
      saves: savesArr[i],
      superSavers: options.superSavers[i],
      semiSuperSavers: options.semiSuperSavers[i],
    }
  });
  return applyTokenDamageMany({ applyDamageDetails: mappedDamageDetailArray, theTargets, item, options })
}

export async function processDamageRoll(workflow: Workflow, defaultDamageType: string) {
  if (debugEnabled > 0) warn("Process Damage Roll ", workflow)
  // proceed if adding chat damage buttons or applying damage for our selves
  let appliedDamage: any[] = [];
  const actor = workflow.actor;
  let item = workflow.saveItem;

  // const re = /.*\((.*)\)/;
  // const defaultDamageType = message.flavor && message.flavor.match(re);

  // Show damage buttons if enabled, but only for the applicable user and the GM

  let theTargets = new Set([...workflow.hitTargets, ...workflow.hitTargetsEC]);
  if (item?.system.target?.type === "self") theTargets = getSelfTargetSet(actor) || theTargets;
  let effectsToExpire: string[] = [];
  if (theTargets.size > 0 && item?.hasAttack) effectsToExpire.push("1Hit");
  if (theTargets.size > 0 && item?.hasDamage) effectsToExpire.push("DamageDealt");
  if (effectsToExpire.length > 0) {
    await expireMyEffects.bind(workflow)(effectsToExpire);
  }

  warn("damage details pre merge are ", workflow.damageDetail, workflow.bonusDamageDetail);
  let totalDamage = 0;
  let merged = workflow.damageDetail.concat(workflow.bonusDamageDetail ?? []).reduce((acc, item) => {
    acc[item.type] = (acc[item.type] ?? 0) + item.damage;
    return acc;
  }, {});
  if ((Object.keys(merged).length === 1 && Object.keys(merged)[0] === "midi-none") &&
    (workflow.shouldRollOtherDamage && Object.keys(workflow.otherDamageDetail).length === 1 && Object.keys(workflow.otherDamageDetail)[0] === "midi-none")
  ) return;

  //TODO come back and decide if -ve damage per type should be allowed, no in the case of 1d4 -2, yes? in the case of -1d4[fire]
  const newDetail = Object.keys(merged).map((key) => { return { damage: Math.max(0, merged[key]), type: key } });
  totalDamage = newDetail.reduce((acc, value) => acc + value.damage, 0);
  workflow.damageDetail = newDetail;
  workflow.damageTotal = totalDamage;
  workflow.bonusDamageDetail = undefined;
  workflow.bonusDamageTotal = undefined;
  // TODO come back and remove bonusDamage from the args to applyTokenDamageMany
  // Don't check for critical - RAW say these don't get critical damage
  // if (["rwak", "mwak"].includes(item?.system.actionType) && configSettings.rollOtherDamage !== "none") {
  if (workflow.shouldRollOtherDamage) {
    if ((workflow.otherDamageFormula ?? "") !== "" && configSettings.singleConcentrationRoll) {
      appliedDamage = await applyTokenDamageMany(
        {
          applyDamageDetails: [
            { label: "defaultDamage", damageDetail: workflow.damageDetail, damageTotal: workflow.damageTotal },
            {
              label: "otherDamage",
              damageDetail: workflow.otherDamageDetail,
              damageTotal: workflow.otherDamageTotal,
              saves: workflow.saves,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            },
            { label: "bonusDamage", damageDetail: workflow.bonusDamageDetail, damageTotal: workflow.bonusDamageTotal }
          ],
          theTargets,
          item,
          options: { existingDamage: [], workflow, updateContext: undefined, forceApply: false }
        }
      );
    } else {
      let savesToUse = (workflow.otherDamageFormula ?? "") !== "" ? undefined : workflow.saves;
      appliedDamage = await applyTokenDamageMany(
        {
          applyDamageDetails: [
            {
              label: "defaultDamage",
              damageDetail: workflow.damageDetail,
              damageTotal: workflow.damageTotal,
              saves: savesToUse,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            },
            {
              label: "bonusDamage",
              damageDetail: workflow.bonusDamageDetail,
              damageTotal: workflow.bonusDamageTotal,
              saves: savesToUse,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            },

          ],
          theTargets,
          item,
          options: { existingDamage: [], workflow, updateContext: undefined, forceApply: false }
        }
      );
      if (workflow.otherDamageRoll) {
        // assume previous damage applied and then calc extra damage
        appliedDamage = await applyTokenDamageMany(
          {
            applyDamageDetails: [{
              label: "otherDamage",
              damageDetail: workflow.otherDamageDetail,
              damageTotal: workflow.otherDamageTotal,
              saves: workflow.saves,
              superSavers: workflow.superSavers,
              semiSuperSavers: workflow.semiSuperSavers
            }],
            theTargets,
            item,
            options: { existingDamage: [], workflow, updateContext: undefined, forceApply: false }
          }
        );
      }
    }
  } else {
    appliedDamage = await applyTokenDamageMany(
      {
        applyDamageDetails: [
          {
            label: "defaultDamage",
            damageDetail: workflow.damageDetail,
            damageTotal: workflow.damageTotal,
            saves: workflow.saves,
            superSavers: workflow.superSavers,
            semiSuperSavers: workflow.semiSuperSavers
          },
          {
            label: "bonusDamage",
            damageDetail: workflow.bonusDamageDetail,
            damageTotal: workflow.bonusDamageTotal,
            saves: workflow.saves,
            superSavers: workflow.superSavers,
            semiSuperSavers: workflow.semiSuperSavers
          },
        ],
        theTargets,
        item,
        options: {
          existingDamage: [],
          workflow,
          updateContext: undefined,
          forceApply: false
        }
      });
  }
  workflow.damageList = appliedDamage;

  if (debugEnabled > 1) debug("process damage roll: ", configSettings.autoApplyDamage, workflow.damageDetail, workflow.damageTotal, theTargets, item, workflow.saves)
}

export let getSaveMultiplierForItem = (item: Item) => {
  // find a better way for this ? perhaps item property
  if (!item) return 1;
  //@ts-ignore
  if (item.actor && item.type === "spell" && item.system.level === 0) { // cantrip
    //@ts-ignore .flags v10
    const midiFlags = getProperty(item.actor.flags, "midi-qol");
    if (midiFlags?.potentCantrip) return 0.5;
  }

  //@ts-ignore item.falgs v10
  const itemProperties: any = item.flags.midiProperties;
  if (itemProperties?.nodam) return 0;
  if (itemProperties?.fulldam) return 1;
  if (itemProperties?.halfdam) return 0.5;
  //@ts-ignore item.system v10
  let description = TextEditor.decodeHTML((item.system.description?.value || "")).toLocaleLowerCase();
  if (description.includes(i18n("midi-qol.fullDamage").toLocaleLowerCase().trim()) || description.includes(i18n("midi-qol.fullDamageAlt").toLocaleLowerCase().trim())) {
    return 1;
  }
  //@ts-ignore item.name v10
  if (noDamageSaves.includes(cleanSpellName(item.name))) return 0;
  if (description?.includes(i18n("midi-qol.noDamage").toLocaleLowerCase().trim()) || description?.includes(i18n("midi-qol.noDamageAlt").toLocaleLowerCase().trim())) {
    return 0.0;
  }
  if (!configSettings.checkSaveText) return configSettings.defaultSaveMult;
  if (description?.includes(i18n("midi-qol.halfDamage").toLocaleLowerCase().trim()) || description?.includes(i18n("midi-qol.halfDamageAlt").toLocaleLowerCase().trim())) {
    return 0.5;
  }
  //  Think about this. if (checkSavesText true && item.hasSave) return 0; // A save is specified but the half-damage is not specified.
  return configSettings.defaultSaveMult;
};

export function requestPCSave(ability, rollType, player, actor, { advantage, disadvantage, flavor, dc, requestId, GMprompt, isMagicSave, magicResistance, magicVulnerability }) {
  const useUuid = true; // for  LMRTFY
  const actorId = useUuid ? actor.uuid : actor.id;
  const playerLetme = !player?.isGM && ["letme", "letmeQuery"].includes(configSettings.playerRollSaves);
  const playerLetMeQuery = "letmeQuery" === configSettings.playerRollSaves;
  const gmLetmeQuery = "letmeQuery" === GMprompt;
  const gmLetme = player.isGM && ["letme", "letmeQuery"].includes(GMprompt);
  let rollAdvantage: number = 0;
  if (player && installedModules.get("lmrtfy") && (playerLetme || gmLetme)) {
    if (((!player.isGM && playerLetMeQuery) || (player.isGM && gmLetmeQuery))) {
      // TODO - reinstated the LMRTFY patch so that the event is properly passed to the roll
      rollAdvantage = 2;
    } else {
      rollAdvantage = (advantage && !disadvantage ? 1 : (!advantage && disadvantage) ? -1 : 0);
    }
    if (isMagicSave) { // rolls done via LMRTFY won't pick up advantage when passed through and we can't pass both advantage and disadvantage
      if (magicResistance && disadvantage) rollAdvantage = 1; // This will make the LMRTFY display wrong
      if (magicVulnerability && advantage) rollAdvantage = -1; // This will make the LMRTFY display wrong
    }
    //@ts-ignore
    let mode = isNewerVersion(game.version ?? game.version, "0.9.236") ? "publicroll" : "roll";
    if (configSettings.autoCheckSaves !== "allShow") {
      mode = "blindroll";
    }
    let message = `${configSettings.displaySaveDC ? "DC " + dc : ""} ${i18n("midi-qol.saving-throw")} ${flavor}`;
    if (rollType === "abil")
      message = `${configSettings.displaySaveDC ? "DC " + dc : ""} ${i18n("midi-qol.ability-check")} ${flavor}`;
    if (rollType === "skill")
      message = `${configSettings.displaySaveDC ? "DC " + dc : ""} ${flavor}`;
    // Send a message for LMRTFY to do a save.
    const socketData = {
      user: player.id,
      actors: [actorId],
      abilities: rollType === "abil" ? [ability] : [],
      saves: rollType === "save" ? [ability] : [],
      skills: rollType === "skill" ? [ability] : [],
      advantage: rollAdvantage,
      mode,
      title: i18n("midi-qol.saving-throw"),
      message,
      formula: "",
      attach: { requestId },
      deathsave: false,
      initiative: false,
      isMagicSave
    }
    if (debugEnabled > 1) debug("process player save ", socketData)
    game.socket?.emit('module.lmrtfy', socketData);
    //@ts-ignore - global variable
    LMRTFY.onMessage(socketData);
  } else { // display a chat message to the user telling them to save
    const actorName = actor.name;
    //@ts-expect-error .version
    const abilityString = isNewerVersion(game.system.version, "2.1.5")
      ? getSystemCONFIG().abilities[ability].label
      : getSystemCONFIG().abilities[ability]
    let content = ` ${actorName} ${configSettings.displaySaveDC ? "DC " + dc : ""} ${abilityString} ${i18n("midi-qol.saving-throw")}`;
    if (advantage && !disadvantage) content = content + ` (${i18n("DND5E.Advantage")}) - ${flavor})`;
    else if (!advantage && disadvantage) content = content + ` (${i18n("DND5E.Disadvantage")}) - ${flavor})`;
    else content + ` - ${flavor})`;
    const chatData = {
      content,
      whisper: [player]
    }
    // think about how to do this if (workflow?.flagTags) chatData.flags = mergeObject(chatData.flags ?? "", workflow.flagTags);
    ChatMessage.create(chatData);
  }
}

export function requestPCActiveDefence(player, actor, advantage, saveItemName, rollDC, formula, requestId) {
  const useUuid = true; // for  LMRTFY
  const actorId = useUuid ? actor.uuid : actor.id;
  if (!player.isGM && false) {
    // TODO - reinstated the LMRTFY patch so that the event is properly passed to the roll
    advantage = 2;
  } else {
    advantage = (advantage === true ? 1 : advantage === false ? -1 : 0);
  }
  //@ts-ignore
  let mode = isNewerVersion(game.version ?? game.version, "0.9.236") ? "publicroll" : "roll";
  if (configSettings.autoCheckSaves !== "allShow") {
    if (checkRule("activeDefenceShowGM"))
      mode = "gmroll"
    else
      mode = "selfroll";
  } else mode = "publicroll";

  let message = `${saveItemName} ${configSettings.displaySaveDC ? "DC " + rollDC : ""} ${i18n("midi-qol.ActiveDefenceString")}`;
  // Send a message for LMRTFY to do a save.
  const socketData = {
    "abilities": [],
    "saves": [],
    "skills": [],
    mode,
    "title": i18n("midi-qol.ActiveDefenceString"),
    message,
    "tables": [],
    user: player.id,
    actors: [actorId],
    advantage,
    formula,
    attach: { requestId, mode },
    deathsave: false,
    initiative: false
  }
  if (debugEnabled > 1) debug("process player save ", socketData)
  game.socket?.emit('module.lmrtfy', socketData);
  // LMRTFY does not emit to self so in case it needs to be handled by the locl client pretend we received it.
  //@ts-expect-error - LMRTFY
  LMRTFY.onMessage(socketData);
}

export function midiCustomEffect(actor, change) {
  if (typeof change?.key !== "string") return true;
  if (!change.key?.startsWith("flags.midi-qol")) return true;
  const variableKeys = [
    "flags.midi-qol.OverTime",
    "flags.midi-qol.optional",
    "flags.midi-qol.advantage",
    "flags.midi-qol.disadvantage",
    "flags.midi-qol.grants",
    "flags.midi-qol.fails",
    "flags.midi-qol.max.damage",
    "flags.midi-qol.min.damage"

  ]; // These have trailing data in the change key change.key values and should always just be a string
  if (change.key === "flags.midi-qol.onUseMacroName") {
    const args = change.value.split(",")?.map(arg => arg.trim());
    const currentFlag = getProperty(actor, "flags.midi-qol.onUseMacroName") ?? "";

    const extraFlag = `[${args[1]}]${args[0]}`;
    let macroString;
    if (currentFlag.length === 0)
      macroString = extraFlag;
    else
      macroString = [currentFlag, extraFlag].join(",");
    setProperty(actor, "flags.midi-qol.onUseMacroName", macroString)
    return true;
  } else if (variableKeys.some(k => change.key.startsWith(k))) {
    if (typeof change.value !== "string") setProperty(actor, change.key, change.value);
    else if (["true", "1"].includes(change.value.trim())) setProperty(actor, change.key, true);
    else if (["false", "0"].includes(change.value.trim())) setProperty(actor, change.key, false);
    else setProperty(actor, change.key, change.value);
  } else if (typeof change.value === "string") {
    let val: any;
    try {
      switch (midiFlagTypes[change.key]) {
        case "string":
          val = change.value; break;
        case "number":
          val = Number.isNumeric(change.value) ? JSON.parse(change.value) : 0; break;
        default: // boolean by default
          val = JSON.parse(change.value) ? true : false;
      }
      setProperty(actor, change.key, val);
    } catch (err) {
      console.warn(`midi-qol | custom flag eval error ${change.key} ${change.value}`, err)
    }
  } else {
    setProperty(actor, change.key, change.value)
  }
  return true;
}

export function checkImmunity(candidate, data, options, user) {
  // Not using this in preference to marking effect unavailable
  const parent: Actor | undefined = candidate.parent;
  if (!parent || !(parent instanceof CONFIG.Actor.documentClass)) return true;

  //@ts-ignore .traits
  const ci = parent.system.traits?.ci?.value;
  const statusId = (data.name || data.label || "no effect").toLocaleLowerCase();
  const returnvalue = !(ci.length && ci.some(c => c === statusId));
  return returnvalue;
}

export function untargetDeadTokens() {
  if (autoRemoveTargets !== "none") {
    game.user?.targets.forEach((t: Token) => {
      //@ts-ignore .system v10
      if (t.actor?.system.attributes.hp.value <= 0) {
        t.setTarget(false, { releaseOthers: false });
      }
    });
  }
}

function replaceAtFields(value, context, options: { blankValue: string | number, maxIterations: number } = { blankValue: "", maxIterations: 4 }) {
  if (typeof value !== "string") return value;
  let count = 0;
  if (!value.includes("@")) return value;
  let re = /@[\w\._\-]+/g
  let result = duplicate(value);
  result = result.replace("@item.level", "@itemLevel") // fix for outdated item.level
  result = result.replace("@flags.midi-qol", "@flags.midiqol");
  // Remove @data references allow a little bit of recursive lookup
  do {
    count += 1;
    for (let match of result.match(re) || []) {
      result = result.replace(match.replace("@data.", "@"), getProperty(context, match.slice(1)) ?? options.blankValue)
    }
  } while (count < options.maxIterations && result.includes("@"));
  return result;
}

export async function processOverTime(wrapped, data, options, user) {
  if (data.round === undefined && data.turn === undefined) return wrapped(data, options, user);
  try {
    await socketlibSocket.executeAsGM("_gmExpirePerTurnBonusActions", { combatUuid: this.uuid });
    await _processOverTime(this, data, options, user)
  } catch (err) {
    error("processOverTime", err)
  } finally {
    return wrapped(data, options, user);
  }
}

export async function doOverTimeEffect(actor, effect, startTurn: boolean = true, options: any = { saveToUse: undefined, rollFlags: undefined, isActionSave: false }) {
  if (game.user?.isGM)
    return gmOverTimeEffect(actor, effect, startTurn, options);
  return socketlibSocket.executeAsGM("gmOverTimeEffect", { actorUuid: actor.uuid, effectUuid: effect.uuid, startTurn, options })
}

export async function gmOverTimeEffect(actor, effect, startTurn: boolean = true, options: any = { saveToUse: undefined, rollFlags: undefined, rollMode: undefined }) {
  const endTurn = !startTurn;
  if (effect.disabled || effect.isSuppressed) return;
  const auraFlags = effect.flags?.ActiveAuras ?? {};
  if (auraFlags.isAura && auraFlags.ignoreSelf) return;
  const rollData = createConditionData({ actor, workflow: undefined, target: undefined });
  // const rollData = actor.getRollData();
  if (!rollData.flags) rollData.flags = actor.flags;
  rollData.flags.midiqol = rollData.flags["midi-qol"];
  const changes = effect.changes.filter(change => change.key.startsWith("flags.midi-qol.OverTime"));
  if (changes.length > 0) for (let change of changes) {
    // flags.midi-qol.OverTime turn=start/end, damageRoll=rollspec, damageType=string, saveDC=number, saveAbility=str/dex/etc, damageBeforeSave=true/[false], label="String"
    let spec = change.value;
    spec = replaceAtFields(spec, rollData, { blankValue: 0, maxIterations: 3 });
    spec = spec.replace(/\s*=\s*/g, "=");
    spec = spec.replace(/\s*,\s*/g, ",");
    spec = spec.replace("\n", "");
    let parts;
    if (spec.includes("#")) parts = spec.split("#");
    else parts = spec.split(",");
    let details: any = {};
    for (let part of parts) {
      const p = part.split("=");
      details[p[0]] = p.slice(1).join("=");
    }
    if (details.turn === undefined) details.turn = "start";
    if (details.applyCondition || details.condition) {
      let applyCondition = details.applyCondition ?? details.condition; // maintain support for condition
      let value = replaceAtFields(applyCondition, rollData, { blankValue: 0, maxIterations: 3 });
      let result;
      try {
        result = evalCondition(value, rollData);
        // result = Roll.safeEval(value);
      } catch (err) {
        console.warn("midi-qol | error when evaluating overtime apply condition - assuming true", value, err)
        result = true;
      }
      if (!result) continue;
    }

    const changeTurnStart = details.turn === "start" ?? false;
    const changeTurnEnd = details.turn === "end" ?? false;
    const actionSave = JSON.parse(details.actionSave ?? "false");
    if (!!!actionSave && !!options.isActionSave) continue;

    if ((endTurn && changeTurnEnd) || (startTurn && changeTurnStart) || (actionSave && options.saveToUse)) {
      const label = (details.label ?? "Damage Over Time").replace(/"/g, "");
      let saveDC;
      try {
        const value = replaceAtFields(details.saveDC, rollData, { blankValue: 0, maxIterations: 3 });
        saveDC = Roll.safeEval(value);
      } catch (err) { saveDC = -1 }
      const saveAbilityString = (details.saveAbility ?? "");
      const saveAbility = (saveAbilityString.includes("|") ? saveAbilityString.split("|") : [saveAbilityString]).map(s => s.trim().toLocaleLowerCase())
      const saveDamage = details.saveDamage ?? "nodamage";
      const saveMagic = JSON.parse(details.saveMagic ?? "false"); //parse the saving throw true/false
      const damageRoll = details.damageRoll;
      const damageType = details.damageType ?? "piercing";
      const itemName = details.itemName;
      const damageBeforeSave = JSON.parse(details.damageBeforeSave ?? "false");
      const macroToCall = details.macro;
      const rollTypeString = details.rollType ?? "save";
      const rollType = (rollTypeString.includes("|") ? rollTypeString.split("|") : [rollTypeString]).map(s => s.trim().toLocaleLowerCase())
      const rollMode = details.rollMode;
      const allowIncapacitated = JSON.parse(details.allowIncapacitated ?? "true");

      const killAnim = JSON.parse(details.killAnim ?? "false");
      const saveRemove = JSON.parse(details.saveRemove ?? "true");

      if (debugEnabled > 0) warn(`Overtime provided data is `, details);
      if (debugEnabled > 0) warn(`OverTime label=${label} startTurn=${startTurn} endTurn=${endTurn} damageBeforeSave=${damageBeforeSave} saveDC=${saveDC} saveAbility=${saveAbility} damageRoll=${damageRoll} damageType=${damageType}`);
      if (actionSave && options.saveToUse) {
        if (!options.rollFlags) return effect.id;
        if (!rollType.includes(options.rollFlags.type) || !saveAbility.includes(options.rollFlags.abilityId ?? options.rollFlags.skillId)) return effect.id;
        let content;
        if (options.saveToUse.total >= saveDC) {
          await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id]), { "expiry-reason": "midi-qol:overTime:actionSave" };
          content = `${(effect.name || effect.label)} ${i18n("midi-qol.saving-throw")} ${i18n("midi-qol.save-success")}`;
        } else
          content = `${(effect.name || effect.label)} ${i18n("midi-qol.saving-throw")} ${i18n("midi-qol.save-failure")}`;
        ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
        return effect.id;
      }

      let itemData: any = duplicate(overTimeJSONData);
      if (typeof itemName === "string") {
        if (itemName.startsWith("Actor.")) { // TODO check this
          const localName = itemName.replace("Actor.", "")
          const theItem = actor.items.getName(localName);
          if (theItem) itemData = theItem.toObject();
        } else {
          const theItem = game.items?.getName(itemName);
          if (theItem) itemData = theItem.toObject();
        }
      }

      itemData.img = effect.icon;
      itemData.system.save.dc = saveDC;
      itemData.system.save.scaling = "flat";
      setProperty(itemData, "flags.midi-qol.noProvokeReaction", true);
      if (saveMagic) {
        itemData.type = "spell";
        itemData.system.preparation = { mode: "atwill" }
      }
      if (rollTypeString === "save" && !actionSave) {
        itemData.system.actionType = "save";
        itemData.system.save.ability = saveAbility[0];

      }
      if (rollTypeString === "check" && !actionSave) {
        itemData.systsem.actionType = "abil";
        itemData.system.save.ability = saveAbility[0];
      }
      if (rollTypeString === "skill" && !actionSave) { // skill checks for this is a fiddle - set a midi flag so that the midi save roll will pick it up.
        itemData.system.actionType = "save";
        let skill = saveAbility[0];
        if (!getSystemCONFIG().skills[skill]) { // not a skill id see if the name matches an entry
          //@ts-expect-error
          const skillEntry = Object.entries(getSystemCONFIG().skills).find(([id, entry]) => entry.label.toLocaleLowerCase() === skill)
          if (skillEntry) skill = skillEntry[0];
          /*
          //@ts-ignore
          const hasEntry = Object.values(getSystemCONFIG().skills).map(entry => entry.label.toLowerCase()).includes(saveAbility)

          if (hasEntry) {
            skill = Object.keys(getSystemCONFIG().skills).find(id => getSystemCONFIG().skills[id].label.toLocaleLowerCase() === saveAbility[0])
          }
          */
        }
        setProperty(itemData, "flags.midi-qol.overTimeSkillRoll", skill)
      }
      if (actionSave) {
        itemData.system.actionType = "other";
        itemData.system.save.dc = undefined;
        itemData.system.save.ability = undefined;
        itemData.system.save.scaling = undefined;
      }

      if (damageBeforeSave || saveDamage === "fulldamage") {
        //@ts-ignore
        setProperty(itemData.flags, "midiProperties.fulldam", true);
      } else if (saveDamage === "halfdamage" || !damageRoll) {
        //@ts-ignore
        setProperty(itemData.flags, "midiProperties.halfdam", true);
      } else {
        //@ts-ignore
        setProperty(itemData.flags, "midiProperties.nodam", true);
      }
      itemData.name = label;
      //@ts-ignore
      itemData._id = randomID();
      // roll the damage and save....
      const theTargetToken = getSelfTarget(actor);
      const theTargetId = theTargetToken?.document.id;
      const theTargetUuid = theTargetToken?.document.uuid;
      if (game.user && theTargetId) game.user.updateTokenTargets([theTargetId]);

      if (damageRoll) {
        let damageRollString = damageRoll;
        let stackCount = effect.flags.dae?.stacks ?? 1;
        if (globalThis.EffectCounter && theTargetToken) {
          const counter = globalThis.EffectCounter.findCounter(theTargetToken, effect.icon)
          if (counter) stackCount = counter.getValue();
        }
        for (let i = 1; i < stackCount; i++)
          damageRollString = `${damageRollString} + ${damageRoll}`;
        //@ts-ignore
        itemData.system.damage.parts = [[damageRollString, damageType]];
      }
      setProperty(itemData.flags, "midi-qol.forceCEOff", true);
      if (killAnim) setProperty(itemData.flags, "autoanimations.killAnim", true)
      if (macroToCall) {
        setProperty(itemData, "flags.midi-qol.onUseMacroName", macroToCall);
        setProperty(itemData, "flags.midi-qol.onUseMacroParts", new OnUseMacros(macroToCall));
      }
      let ownedItem: Item = new CONFIG.Item.documentClass(itemData, { parent: actor });
      if (!actionSave && saveRemove && saveDC > -1)
        failedSaveOverTimeEffectsToDelete[ownedItem.uuid] = { actor, effectId: effect.id };

      if (details.removeCondition) {
        let value = replaceAtFields(details.removeCondition, rollData, { blankValue: 0, maxIterations: 3 });
        let remove;
        try {
          remove = evalCondition(value, rollData);
          // remove = Roll.safeEval(value);
        } catch (err) {
          console.warn("midi-qol | error when evaluating overtime remove condition - assuming true", value, err)
          remove = true;
        }
        if (remove) {
          overTimeEffectsToDelete[ownedItem.uuid] = { actor, effectId: effect.id }
        }
      }
      try {
        const options = {
          systemCard: false,
          createWorkflow: true,
          versatile: false,
          configureDialog: false,
          saveDC,
          checkGMStatus: true,
          targetUuids: [theTargetUuid],
          rollMode,
          workflowOptions: { lateTargeting: "none", autoRollDamage: "onHit", autoFastDamage: true, isOverTime: true, allowIncapacitated },
        };
        await completeItemUse(ownedItem, {}, options); // worried about multiple effects in flight so do one at a time
      } finally {
      }
    }
  }
}

export async function _processOverTime(combat, data, options, user) {
  let prev = (combat.current.round ?? 0) * 100 + (combat.current.turn ?? 0);
  let testTurn = combat.current.turn ?? 0;
  let testRound = combat.current.round ?? 0;
  const last = (data.round ?? combat.current.round) * 100 + (data.turn ?? combat.current.turn);

  // These changed since overtime moved to _preUpdate function instead of hook
  // const prev = (combat.previous.round ?? 0) * 100 + (combat.previous.turn ?? 0);
  // let testTurn = combat.previous.turn ?? 0;
  // let testRound = combat.previous.round ?? 0;
  // const last = (combat.current.round ?? 0) * 100 + (combat.current.turn ?? 0);

  let toTest = prev;
  let count = 0;
  while (toTest <= last && count < 200) { // step through each turn from prev to current
    count += 1; // make sure we don't do an infinite loop
    const actor = combat.turns[testTurn]?.actor;
    const endTurn = toTest < last;
    const startTurn = toTest > prev;

    // Remove reaction used status from each combatant
    if (actor && toTest !== prev) {
      if (await hasUsedReaction(actor)) await removeReactionUsed(actor);
      if (await hasUsedBonusAction(actor)) await removeBonusActionUsed(actor);
      if (await hasUsedAction(actor)) await removeActionUsed(actor);
    }

    // Remove any per turn optional bonus effects
    const midiFlags: any = getProperty(actor, "flags.midi-qol");
    if (actor && toTest !== prev && midiFlags) {
      if (midiFlags.optional) {
        for (let key of Object.keys(midiFlags.optional)) {
          if (midiFlags.optional[key].used) {
            socketlibSocket.executeAsGM("_gmSetFlag", { actorUuid: actor.uuid, base: "midi-qol", key: `optional.${key}.used`, value: false })
            // await actor.setFlag("midi-qol", `optional.${key}.used`, false)
          }
        }
      }
    }

    if (actor) for (let effect of actor.effects) {
      if (effect.changes.some(change => change.key.startsWith("flags.midi-qol.OverTime"))) {
        await doOverTimeEffect(actor, effect, startTurn);
      }
    }
    testTurn += 1;
    if (testTurn === combat.turns.length) {
      testTurn = 0;
      testRound += 1;
      toTest = testRound * 100;
    } else toTest += 1;
  }
}

export async function completeItemRoll(item, options: any) {
  //@ts-ignore .version
  if (isNewerVersion(game.version, "10.278)"))
    console.warn("midi-qol | completeItemRoll(item, options) is deprecated please use completeItemUse(item, config, options)")
  return completeItemUse(item, {}, options);
}

export async function completeItemUse(item, config: any = {}, options: any = { checkGMstatus: false },) {
  let theItem = item;
  if (!(item instanceof CONFIG.Item.documentClass)) {
    // TODO magic items fetch the item call - see when v10 supported
    theItem = new CONFIG.Item.documentClass(await item.item.data(), { parent: item.actor })
  }

  if (game.user?.isGM || !options.checkGMStatus) {
    return new Promise((resolve) => {
      let saveTargets = Array.from(game.user?.targets ?? []).map(t => { return t.id });
      let selfTarget = false;
      if (options.targetUuids && game.user && theItem.system.target.type !== "self") {
        game.user.updateTokenTargets([]);
        for (let targetUuid of options.targetUuids) {
          const theTarget = MQfromUuid(targetUuid);
          if (theTarget) theTarget.object.setTarget(true, { user: game.user, releaseOthers: false, groupSelection: true });
        }
      }
      let hookName = `midi-qol.RollComplete.${item?.uuid}`;
      if (!(item instanceof CONFIG.Item.documentClass)) {
        // Magic items create a pseudo item when doing the roll so have to hope we get the right completion
        hookName = "midi-qol.RollComplete";
      }

      Hooks.once(hookName, (workflow) => {
        if (saveTargets && game.user) {
          game.user?.updateTokenTargets(saveTargets);
        }
        resolve(workflow);
      });

      if (item.magicItem) {
        item.magicItem.magicItemActor.roll(item.magicItem.id, item.id)
        //@ts-ignore .version v10
      } else if (installedModules.get("betterrolls5e") && isNewerVersion(game.modules.get("betterrolls5e")?.version ?? "", "1.3.10")) { // better rolls breaks the normal roll process  
        // TODO check this v10
        globalThis.BetterRolls.rollItem(theItem, { itemData: item.toObject(), vanilla: false, adv: 0, disadv: 0, midiSaveDC: options.saveDC }).toMessage()
      } else {
        if (game.settings.get("midi-qol", "itemUseHooks")) { // Since first call always fails can't check the result
          item.use(config, options)
        } else {
          item.use(config, options).then(result => { if (!result) resolve(result) });
        }
      }
    })
  } else {
    const targetUuids = options.targetUuids ? options.targetUuids : Array.from(game.user?.targets || []).map(t => t.document.uuid); // game.user.targets is always a set of tokens
    const data = {
      itemData: theItem.toObject(false),
      actorUuid: theItem.parent.uuid,
      targetUuids,
      config,
      options
    }
    return await timedAwaitExecuteAsGM("completeItemUse", data)
  }
}

export function untargetAllTokens(...args) {
  let combat: Combat = args[0];
  //@ts-expect-error combat.current
  let prevTurn = combat.current.turn - 1;
  if (prevTurn === -1)
    prevTurn = combat.turns.length - 1;

  const previous = combat.turns[prevTurn];
  if ((game.user?.isGM && ["allGM", "all"].includes(autoRemoveTargets)) || (autoRemoveTargets === "all" && canvas?.tokens?.controlled.find(t => t.id === previous.token?.id))) {
    // release current targets
    game.user?.targets.forEach((t: Token) => {
      t.setTarget(false, { releaseOthers: false });
    });
  }
}

export function checkIncapacitated(actor: Actor, item: Item | undefined = undefined, event: any) {
  if (checkRule("vitalityResource")) {
    const vitality = getProperty(actor, checkRule("vitalityResource")?.trim()) ?? 0;
    //@ts-expect-error .system
    if (vitality <= 0 && actor?.system.attributes?.hp?.value <= 0) {
      log(`${actor.name} is dead`);
      return true;
    }
    return false;
  }

  //@ts-expect-error .system
  if (actor?.system.attributes?.hp?.value <= 0) {
    log(`${actor.name} is incapacitated`)
    return true;
  }
  const token = tokenForActor(actor);
  if (token && ["incapacitated", "Convenient Effect: Incapacitated", "stunned", "Convenient Effect: Stunned"].find(cond => hasCondition(token, cond))) return true;
  return false;
}

export function getUnitDist(x1: number, y1: number, z1: number, token2): number {
  if (!canvas?.dimensions) return 0;
  const unitsToPixel = canvas.dimensions.size / canvas.dimensions.distance;
  z1 = z1 * unitsToPixel;
  const x2 = token2.center.x;
  const y2 = token2.center.y;
  //@ts-ignore
  const z2 = token2.document.elevation * unitsToPixel;

  const d =
    Math.sqrt(
      Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2) + Math.pow(z2 - z1, 2)
    ) / unitsToPixel;
  return d;
}

// not working properly yet
export function getSurroundingHexes(token: Token) {
  let start = canvas?.grid?.grid?.getGridPositionFromPixels(token.center.x, token.center.y);
  // console.error("starting position is ", start);
  if (!start) return;

  const surrounds: any[][] = new Array(11);
  for (let r = 0; r < 11; r++) {
    surrounds[r] = new Array(11);
  }
  for (let c = -5; c <= 5; c++)
    for (let r = -5; r <= 5; r++) {
      const row = start[0] + r;
      const col = start[1] + c
      let [x1, y1] = canvas?.grid?.grid?.getPixelsFromGridPosition(row, col) ?? [0, 0];
      let [x, y] = canvas?.grid?.getCenter(x1, y1) ?? [0, 0];
      if (!x && !y) continue;
      const distance = distancePointToken({ x, y }, token);
      surrounds[r + 5][c + 5] = ({ r: row, c: col, d: distance })
    }
  //  for (let r = -5; r <=5; r++)
  //  console.error("Surrounds are ", ...surrounds[r+5]);
  const filtered = surrounds.map(row => row.filter(ent => {
    const entDist = ent.d / (canvas?.dimensions?.distance ?? 5);
    //@ts-ignore .width v10
    const tokenWidth = token.document.width / 2;
    // console.error(ent.r, ent.c, ent.d, entDist, tokenWidth)
    //@ts-ignore .width v10
    if (token.document.width % 2)
      return entDist >= tokenWidth && entDist <= tokenWidth + 0.5
    else return entDist >= tokenWidth && entDist < tokenWidth + 0.5
  }));
  const hlt = canvas?.grid?.highlightLayers["mylayer"] || canvas?.grid?.addHighlightLayer("mylayer");
  hlt?.clear();

  for (let a of filtered) if (a.length !== 0) {
    a.forEach(item => {
      let [x, y] = canvas?.grid?.grid?.getPixelsFromGridPosition(item.r, item.c) ?? [0, 0];
      // console.error("highlighting ", x, y, item.r, item.c)
      //@ts-ignore
      canvas?.grid?.highlightPosition("mylayer", { x, y, color: game?.user?.color });
    })
    // console.error(...a);
  }
}

export function distancePointToken({ x, y, elevation = 0 }, token, wallblocking = false) {
  if (!canvas || !canvas.scene) return undefined;
  let coverACBonus = 0;
  let tokenTileACBonus = 0;
  let coverData;
  if (!canvas.grid || !canvas.dimensions) undefined;
  if (!token || x == undefined || y === undefined) return undefined;
  if (!canvas || !canvas.grid || !canvas.dimensions) return undefined;
  const t2StartX = -Math.max(0, token.document.width - 1);
  const t2StartY = -Math.max(0, token.document.heidght - 1);
  var d, r, segments: { ray: Ray }[] = [], rdistance, distance;
  const [row, col] = canvas.grid.grid?.getGridPositionFromPixels(x, y) || [0, 0];
  const [xbase, ybase] = canvas.grid.grid?.getPixelsFromGridPosition(row, col) || [0, 0];
  const [xc, yc] = canvas.grid.grid?.getCenter(xbase, ybase) || [0, 0];
  // const snappedOrigin = canvas?.grid?.getSnappedPosition(x,y)
  const origin = new PIXI.Point(x, y);
  const tokenCenter = token.center;
  const ray: Ray = new Ray(origin, tokenCenter)
  distance = canvas?.grid?.grid?.measureDistances([{ ray }], { gridSpaces: false })[0];
  distance = Math.max(0, distance);
  return distance;
}

export function getDistanceSimpleOld(t1: Token, t2: Token, incoludeCover, wallBlocking = false) {
  return getDistance(t1, t2, wallBlocking);
}
export function getDistanceSimple(t1: Token, t2: Token, wallBlocking = false) {
  return getDistance(t1, t2, wallBlocking);
}
/** takes two tokens of any size and calculates the distance between them
*** gets the shortest distance betwen two tokens taking into account both tokens size
*** if wallblocking is set then wall are checked
**/
export function getDistance(t1: any /*Token*/, t2: any /*Token*/, wallblocking = false): number {
  if (!canvas || !canvas.scene) return -1;
  if (!canvas.grid || !canvas.dimensions) return -1;
  if (!t1 || !t2) return -1;
  if (t1 instanceof TokenDocument) t1 = t1.object;
  if (t2 instanceof TokenDocument) t2 = t2.object;
  if (!canvas || !canvas.grid || !canvas.dimensions) return -1;


  const t1StartX = t1.document.width >= 1 ? 0.5 : t1.document.width / 2;
  const t1StartY = t1.document.height >= 1 ? 0.5 : t1.document.height / 2;
  const t2StartX = t2.document.width >= 1 ? 0.5 : t2.document.width / 2;
  const t2StartY = t2.document.height >= 1 ? 0.5 : t2.document.height / 2;
  const t1Elevation = t1.document.elevation ?? 0;
  const t2Elevation = t2.document.elevation ?? 0;
  const t1TopElevation = t1Elevation + Math.max(t1.document.height, t1.document.width) * (canvas?.dimensions?.distance ?? 5);
  const t2TopElevation = t2Elevation + Math.min(t2.document.height, t2.document.width) * (canvas?.dimensions?.distance ?? 5); // assume t2 is trying to make itself small
  let coverVisible;
  // For levels autocover and simbul's cover calculator pre-comput token cover - full cover means no attack and so return -1
  // otherwise don't bother doing los checks they are overruled by the cover check
  if (installedModules.get("levelsautocover") && game.settings.get("levelsautocover", "apiMode") && wallblocking && configSettings.optionalRules.wallsBlockRange == "levelsautocover") {

    //@ts-expect-error
    const levelsautocoverData = AutoCover.calculateCover(t1, t2, getLevelsAutoCoverOptions());
    coverVisible = levelsautocoverData.rawCover > 0;
    if (!coverVisible) return -1;
  }
  else if (globalThis.CoverCalculator && configSettings.optionalRules.wallsBlockRange === "simbuls-cover-calculator") {
    if (t1 === t2) return 0; // Simbul's throws an error when calculating cover for the same token
    const coverData = globalThis.CoverCalculator.Cover(t1, t2);
    console.warn("simbuls cover calculator ", t1.name, t2.name, coverData);
    if (coverData?.data.results.cover === 3) return -1;
    coverVisible = true;
  }

  var x, x1, y, y1, d, r, segments: { ray: Ray }[] = [], rdistance, distance;
  for (x = t1StartX; x < t1.document.width; x++) {
    for (y = t1StartY; y < t1.document.height; y++) {
      const origin = new PIXI.Point(...canvas.grid.getCenter(Math.round(t1.document.x + (canvas.dimensions.size * x)), Math.round(t1.document.y + (canvas.dimensions.size * y))));
      for (x1 = t2StartX; x1 < t2.document.width; x1++) {
        for (y1 = t2StartY; y1 < t2.document.height; y1++) {
          const dest = new PIXI.Point(...canvas.grid.getCenter(Math.round(t2.document.x + (canvas.dimensions.size * x1)), Math.round(t2.document.y + (canvas.dimensions.size * y1))));
          const r = new Ray(origin, dest);
          if (wallblocking) {
            switch (configSettings.optionalRules.wallsBlockRange) {
              case "center":
                let collisionCheck;
                //@ts-expect-error version
                if (isNewerVersion(game.version, "11.0")) {
                  //@ts-expect-error polygonBackends
                  collisionCheck = CONFIG.Canvas.polygonBackends.sight.testCollision(origin, dest, { mode: "any", type: "sight" })
                } else {
                  //@ts-expect-error
                  collisionCheck = CONFIG.Canvas.losBackend.testCollision(origin, dest, { mode: "any", type: "sight" })
                }
                if (collisionCheck) continue;
                break;
              case "centerLevels":
                // //@ts-expect-error
                // TODO include auto cover calcs in checking console.error(AutoCover.calculateCover(t1, t2));
                if (configSettings.optionalRules.wallsBlockRange === "centerLevels" && installedModules.get("levels")) {
                  if (coverVisible === false) continue;
                  if (coverVisible === undefined) {
                    let p1 = {
                      x: origin.x,
                      y: origin.y,
                      //@ts-ignore
                      z: t1Elevation
                    }
                    let p2 = {
                      x: dest.x,
                      y: dest.y,
                      //@ts-ignore
                      z: t2Elevation
                    }
                    if (coverVisible === undefined) {
                      //@ts-ignore
                      const baseToBase = CONFIG.Levels.API.testCollision(p1, p2, "sight");
                      p1.z = t1TopElevation;
                      p2.z = t2TopElevation;
                      //@ts-ignore
                      const topToBase = CONFIG.Levels.API.testCollision(p1, p2, "sight");
                      if (baseToBase && topToBase) continue;
                    }
                  }
                } else {
                  let collisionCheck;
                  //@ts-expect-error version
                  if (isNewerVersion(game.version, "11.0")) {
                    //@ts-expect-error polygonBackends
                    collisionCheck = CONFIG.Canvas.polygonBackends.sight.testCollision(origin, dest, { mode: "any", type: "sight" })
                  } else {
                    //@ts-expect-error
                    collisionCheck = CONFIG.Canvas.losBackend.testCollision(origin, dest, { mode: "any", type: "sight" })
                  }
                  if (collisionCheck) continue;
                }
                break;
              case "simbuls-cover-calculator":
                if (coverVisible === undefined) {
                  let collisionCheck;
                  //@ts-expect-error version
                  if (isNewerVersion(game.version, "11.0")) {
                    //@ts-expect-error polygonBackends
                    collisionCheck = CONFIG.Canvas.polygonBackends.sight.testCollision(origin, dest, { mode: "any", type: "sight" })
                  } else {
                    //@ts-expect-error
                    collisionCheck = CONFIG.Canvas.losBackend.testCollision(origin, dest, { mode: "any", type: "sight" })
                  }
                  if (collisionCheck) continue;
                } else if (coverVisible === false) continue;
                break;
              case "none":
              default:
            }
          }
          segments.push({ ray: r });
        }
      }
    }
  }
  if (segments.length === 0) {
    return -1;
  }
  //@ts-ignore
  rdistance = segments.map(ray => canvas.grid.measureDistances([ray], { gridSpaces: true })[0]);
  distance = rdistance[0];
  rdistance.forEach(d => { if (d < distance) distance = d; });
  if (configSettings.optionalRules.distanceIncludesHeight) {
    let heightDifference = 0;
    let t1ElevationRange = Math.max(t1.document.height, t1.document.width) * (canvas?.dimensions?.distance ?? 5);
    if (Math.abs(t2Elevation - t1Elevation) < t1ElevationRange) {
      // token 2 is within t1's size so height difference is functionally 0
      heightDifference = 0;
    } else if (t1Elevation < t2Elevation) { // t2 above t1
      heightDifference = t2Elevation - t1TopElevation;
    } else if (t1Elevation > t2Elevation) { // t1 above t2
      heightDifference = t1Elevation - t2TopElevation;
    }
    //@ts-ignore diagonalRule from DND5E
    const rule = canvas.grid.diagonalRule
    if (["555", "5105"].includes(rule)) {
      let nd = Math.min(distance, heightDifference);
      let ns = Math.abs(distance - heightDifference);
      distance = nd + ns;
      let dimension = canvas?.dimensions?.distance ?? 5;
      if (rule === "5105") distance = distance + Math.floor(nd / 2 / dimension) * dimension;

    } else distance = Math.sqrt(heightDifference * heightDifference + distance * distance);
  }
  return distance;
};

let pointWarn = debounce(() => {
  ui.notifications?.warn("4 Point LOS check selected but dnd5e-helpers not installed")
}, 100)

export function checkRange(itemIn, tokenIn, targetsIn): { result: string, attackingToken?: Token } {
  if (!canvas || !canvas.scene) return { result: "normal" };
  const checkRangeFunction = (item, token, targets): { result: string, reason?: string } => {
    if (!canvas || !canvas.scene) return {
      result: "normal",
    }
    // check that a range is specified at all
    if (!item.system.range) return {
      result: "normal",
    };

    if (!token) {
      if (debugEnabled > 0) warn(`${game.user?.name} no token selected cannot check range`)
      return {
        result: "fail",
        reason: `${game.user?.name} no token selected`,
      }
    }

    let actor = token.actor;
    if (!item.system.range.value && !item.system.range.long && item.system.range.units !== "touch") return {
      result: "normal",
    };
    if (item.system.target?.type === "self") return {
      result: "normal",
    };
    // skip non mwak/rwak/rsak/msak types that do not specify a target type
    if (!allAttackTypes.includes(item.system.actionType) && !["creature", "ally", "enemy"].includes(item.system.target?.type)) return {
      result: "normal",
    };

    let range = item.system.range?.value || 0;
    let longRange = item.system.range?.long || 0;
    if (item.system.range?.units) {
      switch (item.system.range.units) {
        case "mi": // miles - assume grid units are feet or miles - ignore furlongs/chains whatever
          //@ts-ignore
          if (["feet", "ft"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 5280;
            longRange *= 5280;
            //@ts-ignore
          } else if (["yards", "yd", "yds"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 1760;
            longRange *= 1760;
          }
          break;
        case "km": // kilometeres - assume grid units are meters or kilometers
          //@ts-ignore
          if (["meter", "m", "meters", "metre", "metres"].includes(canvas?.scene?.grid.units?.toLocaleLowerCase())) {
            range *= 1000;
            longRange *= 1000;
          }
          break;
        // "none" "self" "ft" "m" "any" "spec":
        default:
          break;
      }
    }
    if (getProperty(actor, "flags.midi-qol.sharpShooter") && range < longRange) range = longRange;
    if (item.system.actionType === "rsak" && getProperty(actor, "flags.dnd5e.spellSniper")) {
      range = 2 * range;
      longRange = 2 * longRange;
    }
    if (item.system.range.units === "touch") {
      range = canvas?.dimensions?.distance ?? 5;
      longRange = 0;
    }
    if (["mwak", "msak", "mpak"].includes(item.system.actionType) && !item.system.properties?.thr) longRange = 0;
    for (let target of targets) {
      if (target === token) continue;
      // check the range
      const distance = getDistance(token, target, configSettings.optionalRules.wallsBlockRange);

      if ((longRange !== 0 && distance > longRange) || (distance > range && longRange === 0)) {
        log(`${target.name} is too far ${distance} from your character you cannot hit`)
        return {
          result: "fail",
          reason: `${actor.name}'s target is ${Math.round(distance * 10) / 10} away and your range is only ${longRange || range}`,
        }
      }
      if (distance > range) return {
        result: "dis",
        reason: `${actor.name}'s target is ${Math.round(distance * 10) / 10} away and your range is only ${longRange || range}`,
      }
      if (distance < 0) {
        log(`${target.name} is blocked by a wall`)
        return {
          result: "fail",
          reason: `${actor.name}'s target is blocked by a wall`,
        }
      }
    }
    return {
      result: "normal",
    }
  }

  let attackingToken = tokenIn;
  if (!canvas || !canvas.tokens) return {
    result: "fail",
    attackingToken: tokenIn,
  }

  const canOverride = getProperty(tokenIn.actor, "flags.midi-qol.rangeOverride.attack.all") || getProperty(tokenIn.actor, `flags.midi-qol.rangeOverride.attack.${itemIn.system.actionType}`)

  if (!canOverride) { // no overrides so just do the check
    const { result, reason } = checkRangeFunction(itemIn, attackingToken, targetsIn);
    if (result === "fail" && reason) {
      ui.notifications?.warn(reason);
    }
    return { result, attackingToken }
  }

  const ownedTokens = canvas.tokens.ownedTokens;
  // Initial Check
  // Now we loop through all owned tokens
  let possibleAttackers: Token[] = ownedTokens.filter(t => {
    const canOverride = getProperty(t.actor ?? {}, "flags.midi-qol.rangeOverride.attack.all") || getProperty(t.actor ?? {}, `flags.midi-qol.rangeOverride.attack.${itemIn.system.actionType}`)
    return canOverride;
  });

  const successToken = possibleAttackers.find(attacker => checkRangeFunction(itemIn, attacker, targetsIn).result === "normal");
  if (successToken) return { result: "normal", attackingToken: successToken };
  const disToken = possibleAttackers.find(attacker => checkRangeFunction(itemIn, attacker, targetsIn).result === "dis");
  return { result: "fail", attackingToken };
}

function getLevelsAutoCoverOptions(): any {
  const options: any = {};
  options.tokensProvideCover = game.settings.get("levelsautocover", "tokensProvideCover");
  options.ignoreFriendly = game.settings.get("levelsautocover", "ignoreFriendly");
  options.copsesProvideCover = game.settings.get("levelsautocover", "copsesProvideCover");
  options.tokenCoverAA = game.settings.get("levelsautocover", "tokenCoverAA");
  // options.coverData ?? this.getCoverData();
  options.precision = game.settings.get("levelsautocover", "coverRestriction");
  return options;
}

export const FULL_COVER = 999;
export const THREE_QUARTERS_COVER = 5;
export const HALF_COVER = 2;

export function computeCoverBonus(attacker: Token | TokenDocument, target: Token | TokenDocument, item: any = undefined) {
  let coverBonus = 0;
  if (!attacker) return coverBonus;
  //@ts-expect-error .Levels
  let levelsAPI = CONFIG.Levels?.API;
  switch (configSettings.optionalRules.coverCalculation) {
    case "levelsautocover":
      if (!installedModules.get("levelsautocover") || !game.settings.get("levelsautocover", "apiMode")) return 0;
      //@ts-expect-error
      const coverData = AutoCover.calculateCover(attacker.document ? attacker : attacker.object, target.document ? target : target.object);
      // const coverData = AutoCover.calculateCover(attacker, target, {DEBUG: true});
      //@ts-expect-error
      const coverDetail = AutoCover.getCoverData();
      if (coverData.rawCover === 0) coverBonus = FULL_COVER;
      else if (coverData.rawCover > coverDetail[1].percent) coverBonus = 0;
      else if (coverData.rawCover < coverDetail[0].percent) coverBonus = THREE_QUARTERS_COVER;
      else if (coverData.rawCover < coverDetail[1].percent) coverBonus = HALF_COVER;;
      if (coverData.obstructingToken) coverBonus = Math.max(2, coverBonus);
      console.log("midi-qol | ComputerCoverBonus - For token ", attacker.name, " attacking ", target.name, " cover data is ", coverBonus, coverData, coverDetail)
      break;
    case "simbuls-cover-calculator":
      if (!installedModules.get("simbuls-cover-calculator")) return 0;
      if (globalThis.CoverCalculator) {
        //@ts-expect-error
        const coverData = globalThis.CoverCalculator.Cover(attacker.document ? attacker : attacker.object, target);
        if (attacker === target) {
          coverBonus = 0;
          break;
        }
        if (coverData?.data?.results.cover === 3) coverBonus = FULL_COVER;
        else coverBonus = -coverData?.data?.results.value ?? 0;
        console.log("midi-qol | ComputeCover Bonus - For token ", attacker.name, " attacking ", target.name, " cover data is ", coverBonus, coverData)
      }
      break;
    case "none":
      coverBonus = 0;
      break;
  }

  if (item?.flags.midiProperties?.ignoreTotalCover && item.type === "spell") coverBonus = 0;
  else if (item?.flags.midiProperties?.ignoreTotalCover && coverBonus === FULL_COVER) coverBonus = THREE_QUARTERS_COVER;
  if (target.actor)
    setProperty(target.actor, "flags.midi-qol.acBonus", coverBonus);
  return coverBonus;

}
export function isAutoFastAttack(workflow: Workflow | undefined = undefined): boolean {
  if (workflow?.workflowOptions?.autoFastAttack !== undefined) return workflow.workflowOptions.autoFastAttack;
  if (workflow && workflow.workflowType === "DummyWorkflow") return workflow.rollOptions.fastForward;
  return game.user?.isGM ? configSettings.gmAutoFastForwardAttack : ["all", "attack"].includes(configSettings.autoFastForward);
}

export function isAutoFastDamage(workflow: Workflow | undefined = undefined): boolean {
  if (workflow?.workflowOptions?.autoFastDamage !== undefined) return workflow.workflowOptions.autoFastDamage;
  if (workflow?.workflowType === "DummyWorkflow") return workflow.rollOptions.fastForwardDamage;
  return game.user?.isGM ? configSettings.gmAutoFastForwardDamage : ["all", "damage"].includes(configSettings.autoFastForward)
}

export function isAutoConsumeResource(workflow: Workflow | undefined = undefined): string {
  if (workflow?.workflowOptions.autoConsumeResource !== undefined) return workflow?.workflowOptions.autoConsumeResource;
  return game.user?.isGM ? configSettings.gmConsumeResource : configSettings.consumeResource;
}

export function getAutoRollDamage(workflow: Workflow | undefined = undefined): string {
  if (workflow?.workflowOptions?.autoRollDamage) {
    const damageOptions = Object.keys(geti18nOptions("autoRollDamageOptions"));
    if (damageOptions.includes(workflow.workflowOptions.autoRollDamage))
      return workflow.workflowOptions.autoRollDamage;
    console.warn(`midi-qol | could not find ${workflow.workflowOptions.autoRollDamage} workflowOptions.autoRollDamage must be ond of ${damageOptions} defaulting to "onHit"`)
    return "onHit";
  }
  return game.user?.isGM ? configSettings.gmAutoDamage : configSettings.autoRollDamage;
}

export function getAutoRollAttack(workflow: Workflow | undefined = undefined): boolean {
  if (workflow?.workflowOptions?.autoRollAttack !== undefined)
    return workflow.workflowOptions.autoRollAttack;
  return game.user?.isGM ? configSettings.gmAutoAttack : configSettings.autoRollAttack;
}

export function getLateTargeting(workflow: Workflow | undefined = undefined): String {
  if (workflow?.workflowOptions?.lateTargeting !== undefined) return workflow?.workflowOptions?.lateTargeting;
  return game.user?.isGM ? configSettings.gmLateTargeting : lateTargeting;
}

export function itemHasDamage(item) {
  return item?.system.actionType !== "" && item?.hasDamage;
}

export function itemIsVersatile(item) {
  return item?.system.actionType !== "" && item?.isVersatile;
}

export function getRemoveAttackButtons() {
  return game.user?.isGM ?
    ["all", "attack"].includes(configSettings.gmRemoveButtons) :
    ["all", "attack"].includes(configSettings.removeButtons);
}
export function getRemoveDamageButtons() {
  return game.user?.isGM ?
    ["all", "damage"].includes(configSettings.gmRemoveButtons) :
    ["all", "damage"].includes(configSettings.removeButtons);
}

export function getReactionSetting(player: User | null | undefined): string {
  if (!player) return "none";
  return player.isGM ? configSettings.gmDoReactions : configSettings.doReactions;
}

export function getTokenPlayerName(token: TokenDocument | Token) {
  if (!token) return game.user?.name;
  if (installedModules.get("anonymous")) {
    //@ts-expect-error .api
    const api = game.modules.get("anonymous")?.api;
    if (api.playersSeeName(token.actor)) return token.name;
    else return api.getName(token.actor);
  }
  if (!installedModules.get("combat-utility-belt")) return token.name;
  if (!game.settings.get("combat-utility-belt", "enableHideNPCNames")) return token.name;
  //@ts-ignore .flags v10
  if (getProperty(token.actor?.flags ?? {}, "combat-utility-belt.enableHideName"))
    //@ts-ignore .flags v10
    return getProperty(token.actor?.flags ?? {}, "combat-utility-belt.hideNameReplacement")
  if (token.actor?.hasPlayerOwner) return token.name;
  //@ts-ignore .disposition
  switch ((token.document ?? token).disposition) {
    case -1:
      if (game.settings.get("combat-utility-belt", "enableHideHostileNames"))
        return game.settings.get("combat-utility-belt", "hostileNameReplacement")
      break;
    case 1:

      if (game.settings.get("combat-utility-belt", "enableHideFriendlyNames"))
        return game.settings.get("combat-utility-belt", "friendlyNameReplacement")
    default:
    case 0:
      if (game.settings.get("combat-utility-belt", "enableHideNeutralNames"))
        return game.settings.get("combat-utility-belt", "neutralNameReplacement")
  }
  return token.name;
}

export function getSpeaker(actor) {
  const speaker = ChatMessage.getSpeaker({ actor });
  if (!configSettings.useTokenNames) return speaker;
  let token = actor.token;
  if (!token) token = actor.getActiveTokens()[0];
  if (token) speaker.alias = token.name;
  return speaker
}

export interface ConcentrationData {
  item: any;
  targets: Set<Token>;
  templateUuid: string;
}
export async function addConcentration(actor, concentrationData: ConcentrationData) {
  await addConcentrationEffect(actor, concentrationData);
  await setConcentrationData(actor, concentrationData);
}
// Add the concentration marker to the character and update the duration if possible
export async function addConcentrationEffect(actor, concentrationData: ConcentrationData) {
  const item = concentrationData.item;
  // await item.actor.unsetFlag("midi-qol", "concentration-data");
  let selfTarget = actor.token ? actor.token.object : getSelfTarget(actor);
  if (!selfTarget) return;
  let statusEffect;
  if (installedModules.get("dfreds-convenient-effects")) {
    statusEffect = CONFIG.statusEffects.find(se => se.id === "Convenient Effect: Concentrating");
  }
  if (!statusEffect && installedModules.get("combat-utility-belt")) {
    const conditionName = game.settings.get("combat-utility-belt", "concentratorConditionName")
    statusEffect = CONFIG.statusEffects.find(se => se.id.startsWith("combat-utility-belt") && se.label == conditionName);
  }
  if (statusEffect) { // found a cub or convenient status effect.
    const itemDuration = item?.system.duration;
    statusEffect = duplicate(statusEffect);
    // set the token as concentrating
    if (installedModules.get("dae")) {
      const inCombat = (game.combat?.turns.some(combatant => combatant.token?.id === selfTarget.id));
      const convertedDuration = globalThis.DAE.convertDuration(itemDuration, inCombat);
      if (convertedDuration?.type === "seconds") {
        statusEffect.duration = { seconds: convertedDuration.seconds, startTime: game.time.worldTime }
      } else if (convertedDuration?.type === "turns") {
        statusEffect.duration = {
          rounds: convertedDuration.rounds,
          turns: convertedDuration.turns,
          startRound: game.combat?.round,
          startTurn: game.combat?.turn
        }
      }
    }
    statusEffect.origin = item?.uuid
    setProperty(statusEffect.flags, "midi-qol.isConcentration", statusEffect.origin);
    setProperty(statusEffect.flags, "dae.transfer", false);
    setProperty(statusEffect, "transfer", false);

    const existing = selfTarget.actor?.effects.find(e => e.getFlag("core", "statusId") === statusEffect.id);
    if (!existing) {
      return await selfTarget.toggleEffect(statusEffect, { active: true })
      setTimeout(
        () => {
          selfTarget.toggleEffect(statusEffect, { active: true })
        }, 100);
      // return await selfTarget.toggleEffect(statusEffect, { active: true })
    }
    return true;
  } else {
    let concentrationName = i18n("midi-qol.Concentrating");
    const existing = selfTarget.actor?.effects.find(e => (e.name || e.label) === concentrationName);
    if (existing) return undefined; // make sure that we don't double apply concentration

    const inCombat = (game.combat?.turns.some(combatant => combatant.token?.id === selfTarget.id));
    const effectData = {
      changes: [],
      origin: item.uuid, //flag the effect as associated to the spell being cast
      disabled: false,
      icon: itemJSONData.img,
      label: concentrationName,
      duration: {},
      flags: {
        "midi-qol": { isConcentration: item?.uuid },
        "dae": { transfer: false }
      }
    }
    if (installedModules.get("dae")) {
      const convertedDuration = globalThis.DAE.convertDuration(item.system.duration, inCombat);
      if (convertedDuration?.type === "seconds") {
        effectData.duration = { seconds: convertedDuration.seconds, startTime: game.time.worldTime }
      } else if (convertedDuration?.type === "turns") {
        effectData.duration = {
          rounds: convertedDuration.rounds,
          turns: convertedDuration.turns,
          startRound: game.combat?.round,
          startTurn: game.combat?.turn
        }
      }
    }
    return await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }
}

export async function setConcentrationData(actor, concentrationData: ConcentrationData) {
  if (actor && concentrationData.targets) {
    let targets: { tokenUuid: string | undefined, actorUuid: string | undefined }[] = [];
    const selfTargetUuid = actor.uuid;
    let selfTargeted = false;
    for (let hit of concentrationData.targets) {
      const tokenUuid = hit.document?.uuid ?? hit.uuid;
      const actorUuid = hit.actor?.uuid ?? "";
      targets.push({ tokenUuid, actorUuid });
      if (selfTargetUuid === actorUuid) selfTargeted = true;
    }

    if (!selfTargeted) {
      let selfTarget = actor.token ? actor.token.object : getSelfTarget(actor);
      targets.push({ tokenUuid: selfTarget.uuid, actorUuid: actor.uuid })
    }
    let templates = concentrationData.templateUuid ? [concentrationData.templateUuid] : [];
    await actor.setFlag("midi-qol", "concentration-data", { uuid: concentrationData.item.uuid, targets: targets, templates: templates, removeUuids: [] })
  }
}

/** 
 * Find tokens nearby
 * @param {number|null} disposition. same(1), opposite(-1), neutral(0), ignore(null) token disposition
 * @param {Token} token The token to search around
 * @param {number} distance in game units to consider near
 * @param {options} canSee Require that the potential target can sense the token
 * @param {options} isSeen Require that the token can sense the potential target
 * @param {options} includeIcapacitated: boolean count incapacitated tokens
 */


export function findNearby(disposition: number | null, token: any /*Token | uuuidString */, distance: number, options: { maxSize: number | undefined, includeIncapacitated: boolean | undefined, canSee: boolean | undefined, isSeen: boolean | undefined } = { maxSize: undefined, includeIncapacitated: false, canSee: false, isSeen: false }): Token[] {
  if (!token) return [];
  if (typeof token === "string") token = MQfromUuid(token).object;
  if (!(token instanceof Token)) { throw new Error("find nearby token is not of type token or the token uuid is invalid") };
  if (!canvas || !canvas.scene) return [];
  //@ts-ignore .disposition v10
  let targetDisposition = token.document.disposition * (disposition ?? 0);
  let nearby = canvas.tokens?.placeables.filter(t => {
    if (getProperty(t, "actor.system.details.type.custom")?.toLocaleLowerCase().includes("notarget")
    || getProperty(t, "actor.system.details.race")?.toLocaleLowerCase().includes("notarget")) return false;
    //@ts-ignore .height .width v10
    if (options.maxSize && t.document.height * t.document.width > options.maxSize) return false;
    if (t.actor && !options.includeIncapacitated && checkIncapacitated(t.actor, undefined, undefined)) return false;
    let inRange = false;
    if (t.actor &&
      t.id !== token.id && // not the token
      //@ts-ignore .disposition v10      
      (disposition === null || t.document.disposition === targetDisposition)) {
      const tokenDistance = getDistance(t, token, true);
      inRange = 0 <= tokenDistance && tokenDistance <= distance
    } else return false; // wrong disposition
    if (inRange && options.canSee && !canSense(t, token)) return false; // Only do the canSee check if the token is inRange
    if (inRange && options.isSeen && !canSense(token, t)) return false;
    return inRange;

  });
  return nearby ?? [];
}

export function checkNearby(disposition: number | null, token: Token | undefined, distance: number, options: any = {}): boolean {
  return findNearby(disposition, token, distance, options).length !== 0;
}

export function hasCondition(token /* Token | TokenDoucment */, condition: string) {
  if (!token) return false;

  //@ts-ignore specialStatusEffects
  if (condition === "invisible" && (token.document ?? token).hasStatusEffect(CONFIG.specialStatusEffects.INVISIBLE)) return true;
  if ((token.document ?? token).hasStatusEffect(condition)) return true;

  //@ts-ignore
  const cub = game.cub;
  if (installedModules.get("combat-utility-belt") && condition === "invisible" && cub.hasCondition("Invisible", [token], { warn: false })) return true;
  if (installedModules.get("combat-utility-belt") && condition === "hidden" && cub.hasCondition("Hidden", [token], { warn: false })) return true;
  //@ts-ignore
  const CEInt = game.dfreds?.effectInterface;
  if (installedModules.get("dfreds-convenient-effects")) {
    const localCondition = i18n(`midi-qol.${condition}`);
    if (CEInt.hasEffectApplied(localCondition, token.actor.uuid)) return true;
  }
  return false;
}

export async function removeInvisible() {
  if (!canvas || !canvas.scene) return;
  const token: Token | undefined = canvas.tokens?.get(this.tokenId);
  if (!token) return;
  // 
  await removeTokenCondition(token, i18n(`midi-qol.${"invisible"}`));
  //@ts-ignore
  await (token.document ?? token).toggleActiveEffect({ id: CONFIG.specialStatusEffects.INVISIBLE }, { active: false });
  log(`Hidden/Invisibility removed for ${this.actor.name} due to attack`)
}

export async function removeHidden() {
  if (!canvas || !canvas.scene) return;
  const token: Token | undefined = canvas.tokens?.get(this.tokenId);
  if (!token) return;
  // 
  await removeTokenCondition(token, i18n(`midi-qol.${"hidden"}`));
  await removeTokenCondition(token, "Stealth (CV)");
  await removeTokenCondition(token, "Stealthed (CV)");
  //@ts-ignore
  log(`Hidden removed for ${this.actor.name} due to attack`)
}

export async function removeTokenCondition(token: Token, condition: string) {
  if (!token) return;
  //@ts-ignore .label v10
  const hasEffect = token.actor?.effects.find(ef => (ef.name || ef.label) === condition);
  if (hasEffect) await hasEffect.delete();
}

// this = {actor, item, myExpiredEffects}
export async function expireMyEffects(effectsToExpire: string[]) {
  const expireHit = effectsToExpire.includes("1Hit") && !this.effectsAlreadyExpired.includes("1Hit");
  const expireAction = effectsToExpire.includes("1Action") && !this.effectsAlreadyExpired.includes("1Action");
  const expireSpell = effectsToExpire.includes("1Spell") && !this.effectsAlreadyExpired.includes("1Spell");
  const expireAttack = effectsToExpire.includes("1Attack") && !this.effectsAlreadyExpired.includes("1Attack");
  const expireDamage = effectsToExpire.includes("DamageDealt") && !this.effectsAlreadyExpired.includes("DamageDealt");
  const expireInitiative = effectsToExpire.includes("Initiative") && !this.effectsAlreadyExpired.includes("Initiative");

  // expire any effects on the actor that require it
  if (debugEnabled && false) {
    const test = this.actor.effects.map(ef => {
      const specialDuration = getProperty(ef.flags, "dae.specialDuration");
      return [(expireAction && specialDuration?.includes("1Action")),
      (expireAttack && specialDuration?.includes("1Attack") && this.item?.hasAttack),
      (expireHit && this.item?.hasAttack && specialDuration?.includes("1Hit") && this.hitTargets.size > 0)]
    })
    if (debugEnabled > 1) debug("expiry map is ", test)
  }
  const myExpiredEffects = this.actor.effects?.filter(ef => {
    const specialDuration = getProperty(ef.flags, "dae.specialDuration");
    if (!specialDuration || !specialDuration?.length) return false;
    return (expireAction && specialDuration.includes("1Action")) ||
      (expireAttack && this.item?.hasAttack && specialDuration.includes("1Attack")) ||
      (expireSpell && this.item?.type === "spell" && specialDuration.includes("1Spell")) ||
      (expireAttack && this.item?.hasAttack && specialDuration.includes(`1Attack:${this.item?.system.actionType}`)) ||
      (expireHit && this.item?.hasAttack && specialDuration.includes("1Hit") && this.hitTargets.size > 0) ||
      (expireHit && this.item?.hasAttack && specialDuration.includes(`1Hit:${this.item?.system.actionType}`) && this.hitTargets.size > 0) ||
      (expireDamage && this.item?.hasDamage && specialDuration.includes("DamageDealt")) ||
      (expireInitiative && specialDuration.includes("Initiative"))
  }).map(ef => ef.id);
  if (debugEnabled > 1) debug("expire my effects", myExpiredEffects, expireAction, expireAttack, expireHit);
  this.effectsAlreadyExpired = this.effectsAlreadyExpired.concat(effectsToExpire);
  if (myExpiredEffects?.length > 0) await this.actor?.deleteEmbeddedDocuments("ActiveEffect", myExpiredEffects, { "expiry-reason": `midi-qol:${effectsToExpire}` });
}

export async function expireRollEffect(rolltype: string, abilityId: string, success: boolean | undefined) {
  const rollType = rolltype.charAt(0).toUpperCase() + rolltype.slice(1)
  const expiredEffects = this.effects?.filter(ef => {
    const specialDuration = getProperty(ef.flags, "dae.specialDuration");
    if (!specialDuration) return false;
    if (specialDuration.includes(`is${rollType}`)) return true;
    if (specialDuration.includes(`is${rollType}.${abilityId}`)) return true;
    if (success === true && specialDuration.includes(`is${rollType}Success`)) return true;
    if (success === true && specialDuration.includes(`is${rollType}Success.${abilityId}`)) return true;
    if (success === false && specialDuration.includes(`is${rollType}Failure`)) return true;
    if (success === false && specialDuration.includes(`is${rollType}Failure.${abilityId}`)) return true;
    return false;
  }).map(ef => ef.id);
  if (expiredEffects?.length > 0) {
    timedAwaitExecuteAsGM("removeEffects", {
      actorUuid: this.uuid,
      effects: expiredEffects,
      options: { "midi-qol": `special-duration:${rollType}:${abilityId}` }
    });
  }
}

export function validTargetTokens(tokenSet: Set<Token> | undefined | any): Set<Token> {
  return tokenSet.filter(tk => tk.actor);
}

export function MQfromUuid(uuid): any | null {
  if (!uuid || uuid === "") return null;
  //@ts-ignore foundry v10 types
  return fromUuidSync(uuid)
}

export function MQfromActorUuid(uuid): any | null {
  let doc = MQfromUuid(uuid);
  //@ts-ignore doc.actor: any rather than Actor
  if (doc instanceof CONFIG.Token.documentClass) return doc.actor;
  if (doc instanceof CONFIG.Actor.documentClass) return doc;
  return null;
}


class RollModifyDialog extends Application {
  rollExpanded: boolean;

  data: {
    //@ts-ignore dnd5e v10
    actor: globalThis.dnd5e.documents.Actor5e,
    flags: string[],
    flagSelector: string,
    targetObject: any,
    rollId: string,
    rollTotalId: string,
    rollHTMLId: string,
    title: string,
    content: HTMLElement | JQuery<HTMLElement> | string,
    currentRoll: Roll,
    rollHTML: string,
    callback: () => {},
    close: () => {},
    buttons: any,
    rollMode: string | undefined
  }

  constructor(data, options) {
    options.height = "auto";
    options.resizable = true;
    super(options);
    this.data = data;
    this.rollExpanded = false;
    if (!data.rollMode) data.rollMode = game.settings.get("core", "rollMode")
  }

  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      template: "modules/midi-qol/templates/dialog.html",
      classes: ["dialog"],
      width: 600,
      jQuery: true
    }, { overwrite: true });
  }
  get title() {
    return this.data.title || "Dialog";
  }

  async getData(options) {
    this.data.flags = this.data.flags.filter(flagName => {
      if ((getOptionalCountRemaining(this.data.actor, `${flagName}.count`)) < 1) return false;
      return getProperty(this.data.actor, flagName) !== undefined
    });
    if (this.data.flags.length === 0) this.close();
    this.data.buttons = this.data.flags.reduce((obj, flag) => {
      let flagData = getProperty(this.data.actor, flag);
      let value = getProperty(flagData, this.data.flagSelector);
      if (value !== undefined) {
        const labelDetail = Roll.replaceFormulaData(value, this.data.actor.getRollData())
        obj[randomID()] = {
          icon: '<i class="fas fa-dice-d20"></i>',
          //          label: (flagData.label ?? "Bonus") + `  (${getProperty(flagData, this.data.flagSelector) ?? "0"})`,
          label: (flagData.label ?? "Bonus") + `  (${labelDetail})`,
          value,
          key: flag,
          callback: this.data.callback
        }
      }
      let selector = this.data.flagSelector.split(".");
      selector[selector.length - 1] = "all";
      const allSelector = selector.join(".");
      value = getProperty(flagData, allSelector);

      if (value !== undefined) {
        const labelDetail = Roll.replaceFormulaData(value, this.data.actor.getRollData());

        obj[randomID()] = {
          icon: '<i class="fas fa-dice-d20"></i>',
          //          label: (flagData.label ?? "Bonus") + `  (${getProperty(flagData, allSelector) ?? "0"})`,
          label: (flagData.label ?? "Bonus") + `  (${labelDetail})`,
          value,
          key: flag,
          callback: this.data.callback
        }
      }
      return obj;
    }, {})
    // this.data.content = await midiRenderRoll(this.data.currentRoll);
    //@ts-ignore
    // this.data.content = await this.data.currentRoll.render();
    return {
      content: this.data.content, // This is set by the callback
      buttons: this.data.buttons
    }
  }

  activateListeners(html) {
    html.find(".dialog-button").click(this._onClickButton.bind(this));
    $(document).on('keydown.chooseDefault', this._onKeyDown.bind(this));
    html.on("click", ".dice-roll", this._onDiceRollClick.bind(this));
  }

  _onDiceRollClick(event) {
    event.preventDefault();
    // Toggle the message flag
    let roll = event.currentTarget;
    this.rollExpanded = !this.rollExpanded

    // Expand or collapse tooltips
    const tooltips = roll.querySelectorAll(".dice-tooltip");
    for (let tip of tooltips) {
      if (this.rollExpanded) $(tip).slideDown(200);
      else $(tip).slideUp(200);
      tip.classList.toggle("expanded", this.rollExpanded);
    }
  }

  _onClickButton(event) {
    const oneUse = true;
    const id = event.currentTarget.dataset.button;
    const button = this.data.buttons[id];
    this.submit(button);
  }

  _onKeyDown(event) {
    // Close dialog
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  async submit(button) {
    try {
      if (button.callback) {
        await button.callback(this, button);
        // await this.getData({}); Render will do a get data, doing it twice breaks the button data?
        this.render(true);
      }
      // this.close();
    } catch (err) {
      ui.notifications?.error("midi-qol | Optional flag roll error see console for details ");
      error(err);
    }
  }

  async close() {
    if (this.data.close) this.data.close();
    $(document).off('keydown.chooseDefault');
    return super.close();
  }
}

export async function processAttackRollBonusFlags() { // bound to workflow
  let attackBonus = "attack.all";
  if (this.item && this.item.hasAttack) attackBonus = `attack.${this.item.system.actionType}`;
  const optionalFlags = getProperty(this, "actor.flags.midi-qol.optional") ?? {};
  let bonusFlags = Object.keys(optionalFlags)
    .filter(flag => {
      const hasAttackFlag = getProperty(this.actor.flags, `midi-qol.optional.${flag}.attack.all`) !== undefined ||
        getProperty(this.actor.flags, `midi-qol.optional.${flag}.${attackBonus}`) !== undefined;
      if (!hasAttackFlag) return false;
      if (!this.actor.flags["midi-qol"].optional[flag].count) return true;
      return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
    })
    .map(flag => `flags.midi-qol.optional.${flag}`);

  if (bonusFlags.length > 0) {
    this.attackRollHTML = await midiRenderRoll(this.attackRoll);
    await bonusDialog.bind(this)(bonusFlags, attackBonus, false, `${this.actor.name} - ${i18n("DND5E.Attack")} ${i18n("DND5E.Roll")}`, "attackRoll", "attackTotal", "attackRollHTML")
  }
  if (this.targets.size === 1) {
    const targetAC = this.targets.entries().next().value[0].actor.system.attributes.ac.value;
    this.processAttackRoll();
    const isMiss = this.isFumble || this.attackRoll.total < targetAC;
    if (isMiss) {
      bonusFlags = Object.keys(this.actor.flags["midi-qol"]?.optional ?? [])
        .filter(flag => {
          const hasAttackFlag = getProperty(this.actor.flags, `midi-qol.optional.${flag}.attack.fail`) !== undefined;
          if (!hasAttackFlag) return false;
          if (!this.actor.flags["midi-qol"].optional[flag].count) return true;
          return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
        })
        .map(flag => `flags.midi-qol.optional.${flag}`);
      attackBonus = "attack.fail"
      if (bonusFlags.length > 0) {
        this.attackRollHTML = await midiRenderRoll(this.attackRoll);
        await bonusDialog.bind(this)(bonusFlags, attackBonus, true, `${this.actor.name} - ${i18n("DND5E.Attack")} ${i18n("DND5E.Roll")}`, "attackRoll", "attackTotal", "attackRollHTML")
      }
    }
  }
  return this.attackRoll;
}

export async function processDamageRollBonusFlags(): Promise<Roll> { // bound to a workflow
  let damageBonus = "damage.all";
  if (this.item) damageBonus = `damage.${this.item.system.actionType}`;
  const optionalFlags = getProperty(this, "actor.flags.midi-qol.optional") ?? {};
  const bonusFlags = Object.keys(optionalFlags)
    .filter(flag => {
      const hasDamageFlag = getProperty(this.actor.flags, `midi-qol.optional.${flag}.damage.all`) !== undefined ||
        getProperty(this.actor.flags, `midi-qol.optional.${flag}.${damageBonus}`) !== undefined;
      if (!hasDamageFlag) return false;
      return getOptionalCountRemainingShortFlag(this.actor, flag) > 0;
    })
    .map(flag => `flags.midi-qol.optional.${flag}`);
  if (bonusFlags.length > 0) {
    this.damageRollHTML = await midiRenderRoll(this.damageRoll);
    await bonusDialog.bind(this)(bonusFlags, damageBonus, false, `${this.actor.name} - ${i18n("DND5E.Damage")} ${i18n("DND5E.Roll")}`, "damageRoll", "damageTotal", "damageRollHTML")
  }
  return this.damageRoll;
}

export async function bonusDialog(bonusFlags, flagSelector, showRoll, title, rollId: string, rollTotalId: string, rollHTMLId: string, options?: any) {
  const showDiceSoNice = /* ["attackRoll", "damageRoll"].includes(rollId) && */ dice3dEnabled(); // && configSettings.mergeCard;
  return new Promise((resolve, reject) => {
    const callback = async (dialog, button) => {
      let newRoll;
      let reRoll;
      const rollMode = getProperty(this.actor, button.key)?.rollMode ?? game.settings.get("core", "rollMode");
      if (!hasEffectGranting(this.actor, button.key, flagSelector)) return;
      switch (button.value) {
        case "reroll": reRoll = await this[rollId].reroll({ async: true });
          if (showDiceSoNice) await displayDSNForRoll(reRoll, rollId, rollMode);
          newRoll = reRoll; break;
        case "reroll-kh": reRoll = await this[rollId].reroll({ async: true });
          if (showDiceSoNice) await displayDSNForRoll(reRoll, rollId === "attackRoll" ? "attackRollD20" : rollId, rollMode);
          newRoll = reRoll;
          if (reRoll.total <= this[rollId].total) newRoll = this[rollId]; break;
        case "reroll-kl": reRoll = await this[rollId].reroll({ async: true });
          newRoll = reRoll;
          if (reRoll.total > this[rollId].total) newRoll = this[rollId];
          if (showDiceSoNice) await displayDSNForRoll(reRoll, rollId === "attackRoll" ? "attackRollD20" : rollId, rollMode);
          break;
        case "reroll-max": newRoll = await this[rollId].reroll({ async: true, maximize: true });
          if (showDiceSoNice) await displayDSNForRoll(newRoll, rollId === "attackRoll" ? "attackRollD20" : rollId, rollMode);
          break;
        case "reroll-min": newRoll = await this[rollId].reroll({ async: true, minimize: true });
          if (showDiceSoNice) await displayDSNForRoll(newRoll, rollId === "attackRoll" ? "attackRollD20" : rollId, rollMode);
          break;
        case "success": newRoll = await new Roll("99").evaluate({ async: true }); break;
        case "fail": newRoll = await new Roll("-1").evaluate({ async: true }); break;
        default:
          if (typeof button.value === "string" && button.value.startsWith("replace ")) {
            const rollParts = button.value.split(" ");
            newRoll = new Roll(rollParts.slice(1).join(" "), (this.item ?? this.actor).getRollData());
            newRoll = await newRoll.evaluate({ async: true });
            if (showDiceSoNice) await displayDSNForRoll(newRoll, rollId, rollMode);
          } else if (flagSelector.startsWith("damage.") && getProperty(this.actor, `${button.key}.criticalDamage`)) {
            let rollOptions = duplicate(this[rollId].options);
            rollOptions.configured = false;
            // rollOptions = { critical: (this.isCritical || this.rollOptions.critical), configured: false };
            //@ts-expect-error D20Roll
            newRoll = CONFIG.Dice.D20Roll.fromRoll(this[rollId]);
            newRoll.terms.push(new OperatorTerm({ operator: "+" }));
            //@ts-ignore DamageRoll
            const tempRoll = new CONFIG.Dice.DamageRoll(`${button.value}`, this.actor.getRollData(), rollOptions);
            await tempRoll.evaluate({ async: true });
            if (showDiceSoNice) await displayDSNForRoll(tempRoll, rollId, rollMode);
            newRoll._total = this[rollId]._total + tempRoll.total;
            newRoll._formula = `${this[rollId]._formula} + ${tempRoll.formula}`
            newRoll.terms = newRoll.terms.concat(tempRoll.terms);
          } else {
            //@ts-expect-error
            newRoll = CONFIG.Dice.D20Roll.fromRoll(this[rollId]);
            newRoll.terms.push(new OperatorTerm({ operator: "+" }));
            if (Number.isNumeric(button.value)) {
              newRoll.terms.push(new NumericTerm({ number: Number(button.value) }));
              // this[rollId].result = `${this[rollId].result} + ${Number(button.value)}`;
              newRoll._total = this[rollId]._total + Number(button.value);
              newRoll._formula = `${this[rollId]._formula} + ${Number(button.value)}`
            } else {
              const tempRoll = new Roll(button.value, this.actor.getRollData());
              await tempRoll.evaluate({ async: true });
              if (showDiceSoNice) await displayDSNForRoll(tempRoll, rollId, rollMode);
              newRoll._total = this[rollId]._total + tempRoll.total;
              newRoll._formula = `${this[rollId]._formula} + ${tempRoll.formula}`
              newRoll.terms = newRoll.terms.concat(tempRoll.terms);
            }
            //newRoll = new CONFIG.Dice.D20Roll(`${this[rollId].result} + ${button.value}`, (this.item ?? this.actor).getRollData(), rollOptions);
          }
          break;
      }
      if (showRoll && this.category === "ac") { // TODO do a more general fix for displaying this stuff
        const player = playerForActor(this.actor)?.id ?? "";
        // const oldRollHTML = await this[rollId].render() ?? this[rollId].result
        const newRollHTML = await midiRenderRoll(newRoll);
        const chatData: any = {
          // content: `${this[rollId].result} -> ${newRoll.formula} = ${newRoll.total}`,
          flavor: game.i18n.localize("DND5E.ArmorClass"),
          content: `${newRollHTML}`,
          whisper: [player]
        };
        ChatMessage.applyRollMode(chatData, rollMode);
        const chatMessage = await ChatMessage.create(chatData);
      }

      // let originalRoll = CONFIG.Dice.D20Roll.fromRoll(this[rollId]);
      const oldRollHTML = await this[rollId].render() ?? this[rollId].result

      this[rollId] = newRoll;
      this[rollTotalId] = newRoll.total;
      this[rollHTMLId] = await midiRenderRoll(newRoll);
      const macroToCall = getProperty(this.actor, `${button.key}.macroToCall`)?.trim();
      if (macroToCall) {
        if (this instanceof Workflow) {
          const macroData = this.getMacroData();
          this.callMacro(this.item, macroToCall, macroData)
        } else if (this.actor) {
          let item;
          if (typeof macroToCall === "string" && macroToCall.startsWith("ItemMacro.")) {
            const itemName = macroToCall.split(".").slice(1).join(".");
            item = this.actor.items.getName(itemName);
          }
          const dummyWorkflow = new DummyWorkflow(this.actor, item, ChatMessage.getSpeaker({ actor: this.actor }), [], {});
          dummyWorkflow.callMacro(item, macroToCall, dummyWorkflow.getMacroData())
        } else console.warn(`midi-qol | RollModifyDialog no way to call macro ${macroToCall}`)
      }

      dialog.data.rollHTML = this[rollHTMLId];
      dialog.data.content = this[rollHTMLId];
      await removeEffectGranting(this.actor, button.key);
      bonusFlags = bonusFlags.filter(bf => bf !== button.key)
      // this.actor.reset();
      if (bonusFlags.length === 0) {
        dialog.close();
        newRoll.options.rollMode = rollMode;
        resolve(newRoll);
        if (showRoll) {
          // const oldRollHTML = await originalRoll.render() ?? this[rollId].result
          const player = playerForActor(this.actor)?.id ?? "";
          const newRollHTML = reRoll ? await midiRenderRoll(reRoll) : await midiRenderRoll(newRoll);
          const chatData: any = {
            // content: `${this[rollId].result} -> ${newRoll.formula} = ${newRoll.total}`,
            flavor: `${title} ${button.value}`,
            content: `${oldRollHTML}<br>${newRollHTML}`,
            whisper: [player],
          };
          ChatMessage.applyRollMode(chatData, rollMode);
          const chatMessage = ChatMessage.create(chatData);
        }
      }
      dialog.data.flags = bonusFlags;
      dialog.render(true);
      // dialog.close();
    }
    let content;
    let rollMode: any = options?.rollMode ?? game.settings.get("core", "rollMode");
    if (game.user?.isGM) content = this[rollHTMLId];
    else {
      if (["publicroll", "gmroll", "selfroll"].includes(rollMode)) content = this[rollHTMLId];
      else content = "Hidden Roll";
    }
    const dialog = new RollModifyDialog(
      {
        actor: this.actor,
        flags: bonusFlags,
        flagSelector,
        targetObject: this,
        rollId,
        rollTotalId,
        rollHTMLId,
        title,
        content,
        currentRoll: this[rollId],
        rollHTML: this[rollHTMLId],
        rollMode,
        callback,
        close: resolve
      }, {
      width: 400
    }).render(true);
  });
}

//@ts-ignore dnd5e v10
export function getOptionalCountRemainingShortFlag(actor: globalThis.dnd5e.documents.Actor5e, flag: string) {
  const countValue = getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.count`);
  const altCountValue = getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.countAlt`);
  return getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.count`) && getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.countAlt`)

  return getOptionalCountRemaining(actor, `flags.midi-qol.optional.${flag}.count`)
}
//@ts-ignore dnd5e v10
export function getOptionalCountRemaining(actor: globalThis.dnd5e.documents.Actor5e, flag: string) {
  const countValue = getProperty(actor, flag);
  if (!countValue) return 1;

  if (["turn", "each-round", "each-turn"].includes(countValue) && game.combat) {
    let usedFlag = flag.replace(".countAlt", ".used");
    usedFlag = flag.replace(".count", ".used");
    // check for the flag
    if (getProperty(actor, usedFlag)) return 0;
  } else if (countValue === "reaction") {
    // return await hasUsedReaction(actor)
    return actor.getFlag("midi-qol", "actions.reactionCombatRound") && needsReactionCheck(actor) ? 0 : 1;
  } else if (countValue === "every") return 1;
  if (Number.isNumeric(countValue)) return countValue;
  if (countValue.startsWith("ItemUses.")) {
    const itemName = countValue.split(".")[1];
    const item = actor.items.getName(itemName);
    return item?.system.uses.value;
  }
  if (countValue.startsWith("@")) {
    let result = getProperty(actor.system, countValue.slice(1))
    return result;
  }
  return 1;
}

//@ts-ignore dnd5e v10
export async function removeEffectGranting(actor: globalThis.dnd5e.documents.Actor5e, changeKey: string) {
  const effect = actor.effects.find(ef => ef.changes.some(c => c.key.includes(changeKey)))
  if (effect === undefined) return;
  const effectData = effect.toObject();

  const count = effectData.changes.find(c => c.key.includes(changeKey) && c.key.endsWith(".count"));
  const countAlt = effectData.changes.find(c => c.key.includes(changeKey) && c.key.endsWith(".countAlt"));
  if (!count) {
    return actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id], { "expiry-reason": "midi-qol:optionalConsumed" })
  }
  if (Number.isNumeric(count.value) || Number.isNumeric(countAlt?.value)) {
    if (count.value <= 1 || countAlt?.value <= 1)
      return actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id], { "expiry-reason": "midi-qol:optionalConsumed" })
    else if (Number.isNumeric(count.value)) {
      count.value = `${count.value - 1}`; // must be a string
    } else if (Number.isNumeric(countAlt?.value)) {
      countAlt.value = `${countAlt.value - 1}`; // must be a string
    }
    actor.updateEmbeddedDocuments("ActiveEffect", [effectData], { "expiry-reason": "midi-qol:optionalConsumed" })
  }
  if (typeof count.value === "string" && count.value.startsWith("ItemUses.")) {
    const itemName = count.value.split(".")[1];
    const item = actor.items.getName(itemName);
    if (!item) {
      ui.notifications?.warn(`midi-qol | could not decrement uses for ${itemName} on actor ${actor.name}`);
      console.warn(`midi-qol | could not decrement uses for ${itemName} on actor ${actor.name}`);
      return;
    }
    await item.update({ "system.uses.value": Math.max(0, item.system.uses.value - 1) });
  }
  if (typeof countAlt?.value === "string" && countAlt.value.startsWith("ItemUses.")) {
    const itemName = countAlt.value.split(".")[1];
    const item = actor.items.getName(itemName);
    if (!item) {
      ui.notifications?.warn(`midi-qol | could not decrement uses for ${itemName} on actor ${actor.name}`);
      console.warn(`midi-qol | could not decrement uses for ${itemName} on actor ${actor.name}`);
      return;
    }
    await item.update({ "system.uses.value": Math.max(0, item.system.uses.value - 1) });
  }

  const actorUpdates: any = {};
  if (typeof count.value === "string" && count.value.startsWith("@")) {
    let key = count.value.slice(1);
    if (key.startsWith("system.")) key = key.replace("system.", "")
    // we have an @field to consume
    let charges = getProperty(actor.system, key)
    if (charges) {
      charges -= 1;
      actorUpdates[`system.${key}`] = charges;
    }
  }
  if (typeof countAlt?.value === "string" && countAlt.value.startsWith("@")) {
    let key = countAlt.value.slice(1);
    if (key.startsWith("system.")) key = key.replace("system.", "")
    // we have an @field to consume
    let charges = getProperty(actor.system, key)
    if (charges) {
      charges -= 1;
      actorUpdates[`system.${key}`] = charges;
    }
  }
  //@ts-ignore v10 isEmpty
  if (!isEmpty(actorUpdates)) await actor.update(actorUpdates);

  if (["turn", "each-round", "each-turn"].includes(count.value)) {
    const flagKey = `${changeKey}.used`.replace("flags.midi-qol.", "");
    await actor.setFlag("midi-qol", flagKey, true);
  }
  if (["turn", "each-round", "each-turn"].includes(countAlt?.value)) {
    const flagKey = `${changeKey}.used`.replace("flags.midi-qol.", "");
    await actor.setFlag("midi-qol", flagKey, true);
  }

  if (count.value === "reaction" || countAlt?.value === "reactopm") {
    setReactionUsed(actor);
  }
}

//@ts-ignore dnd5e v10
export function hasEffectGranting(actor: globalThis.dnd5e.documents.Actor5e, key: string, selector: string) {
  // Actually check for the flag being set...
  if (getOptionalCountRemainingShortFlag(actor, key) <= 0) return false;
  let changeKey = `${key}.${selector}`;
  // let hasKey = actor.effects.find(ef => ef.changes.some(c => c.key === changeKey) && getOptionalCountRemainingShortFlag(actor, key) > 0)
  let hasKey = getProperty(actor, changeKey);
  if (hasKey !== undefined) return true;
  let allKey = selector.split(".");
  allKey[allKey.length - 1] = "all";
  changeKey = `${key}.${allKey.join(".")}`;
  // return actor.effects.find(ef => ef.changes.some(c => c.key === changeKey) && getOptionalCountRemainingShortFlag(actor, key) > 0)
  hasKey = getProperty(actor, changeKey);
  if (hasKey !== undefined) return hasKey;
  return false;

}
//@ts-expect-error dnd5e
export function isConcentrating(actor: globalThis.dnd5e.documents.Actor5e): undefined | ActiveEffect {
  const concentrationName = installedModules.get("combat-utility-belt") && !installedModules.get("dfreds-convenient-effects")
    ? game.settings.get("combat-utility-belt", "concentratorConditionName")
    : i18n("midi-qol.Concentrating");
  return actor.effects.contents.find(e => (e.name || e.label) === concentrationName && !e.disabled && !e.isSuppressed);
}

function maxCastLevel(actor) {
  if (configSettings.ignoreSpellReactionRestriction) return 9;
  const spells = actor.system.spells;
  if (!spells) return 0;
  let pactLevel = spells.pact?.value ? spells.pact?.level : 0;
  for (let i = 9; i > pactLevel; i--) {
    if (spells[`spell${i}`]?.value > 0) return i;
  }
  return pactLevel;
}

async function getMagicItemReactions(actor: Actor, triggerType: string): Promise<Item[]> {
  if (!globalThis.MagicItems) return [];
  const items: Item[] = []
  try {
    const magicItemActor = globalThis.MagicItems.actor(actor.id);
    if (!magicItemActor) return [];
    // globalThis.MagicItems.actor(_token.actor.id).items[0].ownedEntries[0].ownedItem
    for (let magicItem of magicItemActor.items) {
      for (let ownedItem of magicItem.ownedEntries) {
        try {
          const theItem = await ownedItem.item.data()
          if (theItem.system.activation.type === triggerType) {
            items.push(ownedItem);
          }
        } catch (err) {
          console.warn("midi-qol | err fetching magic item ", ownedItem, err);
        }
      }
    }
  } catch (err) {
    console.warn(`midi-qol | Fetching magic item spells/features on ${actor.name} failed - ignoring`, err)
  }
  return items;
}

function itemReaction(item, triggerType, maxLevel, onlyZeroCost) {
  //@ts-ignore activation
  if (item.system.activation?.type !== triggerType) return false;
  if (item.system.activation?.cost > 0 && onlyZeroCost) return false;
  if (item.type === "spell") {
    if (configSettings.ignoreSpellReactionRestriction) return true;
    if (item.system.preparation.mode === "atwill") return true;
    if (item.system.level === 0) return true;
    if (item.system.preparation?.prepared !== true && item.system.preparation?.mode === "prepared") return false;
    if (item.system.preparation.mode !== "innate") return item.system.level <= maxLevel;
  }
  if (item.system.attunement === getSystemCONFIG().attunementTypes.REQUIRED) return false;
  if (!item._getUsageUpdates({ consumeRecharge: item.system.recharge?.value, consumeResource: true, consumeSpellLevel: false, consumeUsage: item.system.uses?.max > 0, consumeQuantity: item.type === "consumable" })) return false;
  return true;
}

export async function doReactions(target: Token, triggerTokenUuid: string | undefined, attackRoll: Roll, triggerType: string, options: any = {}): Promise<{ name: string | undefined, uuid: string | undefined, ac: number | undefined }> {
  //@ts-expect-error
  if (target instanceof TokenDocument) target = target.object;
  const noResult = { name: undefined, uuid: undefined, ac: undefined };
  //@ts-ignore attributes
  if (!target.actor || !target.actor.flags) return noResult;
  if (checkRule("incapacitated")) {
    try {
      enableNotifications(false);
      if (checkIncapacitated(target.actor, undefined, undefined)) return noResult;
    } finally {
      enableNotifications(true);
    }
  }

  // TODO if hasUsedReactions only allow 0 activation cost reactions
  const usedReaction = await hasUsedReaction(target.actor);
  // if (usedReaction && needsReactionCheck(target.actor)) return noResult;
  let player = playerFor(target.document ?? target);
  if (getReactionSetting(player) === "none") return noResult;
  if (!player || !player.active) player = ChatMessage.getWhisperRecipients("GM").find(u => u.active);
  if (!player) return noResult;
  const maxLevel = maxCastLevel(target.actor);
  enableNotifications(false);
  let reactions;
  let reactionCount = 0;
  let reactionItemUuidList: string[] = [] // TODO can't pass a Uuid list if magic items included
  try {
    reactions = target.actor.items.filter(item => itemReaction(item, triggerType, maxLevel, usedReaction));
    // reactionItemUuidList = reactions.map(item => item.uuid);
    if (getReactionSetting(player) === "allMI") {
      reactions = reactions.concat(await getMagicItemReactions(target.actor, triggerType));
    }
    reactionCount = reactions.length;
  } finally {
    enableNotifications(true);
  }

  // TODO Check this for magic items if that makes it to v10
  if (!await asyncHooksCall("midi-qol.ReactionFilter", reactions, options, triggerType)) {
    console.warn("midi-qol | Reaction processing cancelled by Hook");
    return { name: "Filter", ac: 0, uuid: undefined };
  } // else reactionItemUuidList = reactions.map(item => item.uuid);

  // if (usedReaction) return noResult;
  if (!usedReaction) {
    //@ts-ignore .flags v10
    const midiFlags: any = target.actor.flags["midi-qol"];
    reactionCount = reactionCount + Object.keys(midiFlags?.optional ?? [])
      .filter(flag => {
        if (triggerType !== "reaction" || !midiFlags?.optional[flag].ac) return false;
        if (!midiFlags?.optional[flag].count) return true;
        return getOptionalCountRemainingShortFlag(target.actor, flag) > 0;
      }).length
  }

  if (reactionCount <= 0) return noResult;

  let promptString = "midi-qol.reactionFlavorDamage";
  if (triggerType === "reactionattack") promptString = "midi-qol.reactionFlavorAttack";;
  if (triggerType === "reactionpreattack") promptString = "midi-qol.reactionFlavorPreAttack";;

  let chatMessage;
  const reactionFlavor = game.i18n.format(promptString, { itemName: (options.item?.name ?? "unknown"), actorName: target.name });
  const chatData: any = {
    content: reactionFlavor,
    whisper: [player]
  };

  if (configSettings.showReactionChatMessage) {
    const player = playerFor(target.document)?.id ?? "";
    if (configSettings.enableddbGL && installedModules.get("ddb-game-log")) {
      const workflow = Workflow.getWorkflow(options?.item?.uuid);
      if (workflow?.flagTags) chatData.flags = workflow.flagTags;
    }
    chatMessage = await ChatMessage.create(chatData);
  }
  const rollOptions = geti18nOptions("ShowReactionAttackRollOptions");
  // {"none": "Attack Hit", "d20": "d20 roll only", "all": "Whole Attack Roll"},

  let content;
  if (["reactiondamage", "reactionpreattack"].includes(triggerType)) content = reactionFlavor;
  else switch (configSettings.showReactionAttackRoll) {
    case "all":
      content = `<h4>${reactionFlavor} - ${rollOptions.all} ${attackRoll?.total ?? ""}</h4>`;
      break;
    case "d20":
      //@ts-ignore
      const theRoll = attackRoll?.terms[0]?.results ? attackRoll.terms[0].results[0].result : attackRoll?.terms[0]?.total ? attackRoll.terms[0].total : "";

      /* Fix from thatLonelyBugbear when the replaced attack roll is not a true d20 roll (i.e. just a number)
      //@ts-ignore
      const theRoll = attackRoll?.terms[0].results[0].result ?? "";
      */
      content = `<h4>${reactionFlavor} ${rollOptions.d20} ${theRoll}</h4>`;
      break;
    default:
      content = reactionFlavor;
  }


  return await new Promise((resolve) => {
    // set a timeout for taking over the roll
    const timeoutId = setTimeout(() => {
      warn("doReactions | player timeout expired ", player?.name)
      resolve(noResult);
    }, (configSettings.reactionTimeout || 30) * 1000 * 2);

    // Compiler does not realise player can't be undefined to get here
    player && requestReactions(target, player, triggerTokenUuid, content, triggerType, reactionItemUuidList, resolve, chatMessage, options).then(() => {
      clearTimeout(timeoutId);
    })
  })
}

export async function requestReactions(target: Token, player: User, triggerTokenUuid: string | undefined, reactionFlavor: string, triggerType: string, reactionItemUuidList: string[], resolve: ({ }) => void, chatPromptMessage: ChatMessage, options: any = {}) {
  const startTime = Date.now();
  if (options.item && options.item instanceof CONFIG.Item.documentClass) {
    options.itemUuid = options.item.uuid;
    delete options.item;
  };
  /* TODO come back and look at this - adds 80k to the message.
  if (options.workflow && options.workflow instanceof Workflow)
    options.workflow = options.workflow.macroDataToObject(options.workflow.getMacroDataObject());
  */
  if (options.workflow) delete options.workflow;
  const result = await socketlibSocket.executeAsUser("chooseReactions", player.id, {
    tokenUuid: target.document?.uuid ?? target.uuid,
    reactionFlavor,
    triggerTokenUuid,
    triggerType,
    options,
    reactionItemUuidList
  });
  const endTime = Date.now();
  warn("request reactions returned after ", endTime - startTime, result);
  resolve(result);
  if (chatPromptMessage) chatPromptMessage.delete();
}

export async function promptReactions(tokenUuid: string, reactionItemList: string[], triggerTokenUuid: string | undefined, reactionFlavor: string, triggerType: string, options: any = {}) {
  const startTime = Date.now();
  const target: Token = MQfromUuid(tokenUuid);
  const actor: Actor | null = target.actor;
  let player = playerFor(target.document ?? target);
  if (!actor) return;
  const usedReaction = await hasUsedReaction(actor);
  // if ( usedReaction && needsReactionCheck(actor)) return false;
  const midiFlags: any = getProperty(actor, "flags.midi-qol");
  let result;
  let reactionItems;
  const maxLevel = maxCastLevel(target.actor);
  enableNotifications(false);
  let reactions;
  let reactionCount = 0;
  let reactionItemUuidList;
  try {
    enableNotifications(false);
    /*
    // camt do this since magic items don't return a valid uuid.
 enableNotifications(false);
 try {
   reactionItems = reactionItemList.map(uuid => MQfromUuid(uuid));
   // reactionItems = actor.items.filter(item => itemReaction(item, triggerType, maxLevel, usedReaction));
   if (getReactionSetting(game?.user) === "allMI")
     reactionItems = reactionItems.concat(await getMagicItemReactions(actor, triggerType));
 } finally {
   enableNotifications(true);
 }
*/
    reactionItems = target.actor?.items.filter(item => itemReaction(item, triggerType, maxLevel, usedReaction));

    if (target.actor && getReactionSetting(player) === "allMI") {
      reactionItems = reactionItems.concat(await getMagicItemReactions(target.actor, triggerType));
    }
  } finally {
    enableNotifications(true);
  }

  if (reactionItems.length > 0) {
    if (!await asyncHooksCall("midi-qol.ReactionFilter", reactionItems, options, triggerType)) {
      console.warn("midi-qol | Reaction processing cancelled by Hook");
      return { name: "Filter" };
    }
    result = await reactionDialog(actor, triggerTokenUuid, reactionItems, reactionFlavor, triggerType, options);
    const endTime = Date.now();
    warn("prompt reactions reaction processing returned after ", endTime - startTime, result)
    if (result.uuid) return result; //TODO look at multiple choices here
  }
  if (usedReaction) return { name: "None" };
  if (!midiFlags) return { name: "None" };
  const bonusFlags = Object.keys(midiFlags?.optional ?? {})
    .filter(flag => {
      if (!midiFlags.optional[flag].ac) return false;
      if (!midiFlags.optional[flag].count) return true;
      return getOptionalCountRemainingShortFlag(actor, flag) > 0;
    }).map(flag => `flags.midi-qol.optional.${flag}`);
  if (bonusFlags.length > 0 && triggerType === "reaction") {
    //@ts-ignore attributes
    let acRoll = await new Roll(`${actor.system.attributes.ac.value}`).roll({ async: true });
    const data = {
      actor,
      roll: acRoll,
      rollHTML: reactionFlavor,
      rollTotal: acRoll.total,
    }
    //@ts-ignore attributes
    await bonusDialog.bind(data)(bonusFlags, "ac", true, `${actor.name} - ${i18n("DND5E.AC")} ${actor.system.attributes.ac.value}`, "roll", "rollTotal", "rollHTML")
    const endTime = Date.now();
    warn("prompt reactions returned via bonus dialog ", endTime - startTime)
    return { name: actor.name, uuid: actor.uuid, ac: data.roll.total };
  }
  const endTime = Date.now();
  warn("prompt reactions returned no result ", endTime - startTime)
  return { name: "None" };
}

export function playerFor(target: TokenDocument | Token): User | undefined {
  //@ts-expect-error
  return playerForActor(target.document?.actor ?? target.actor ?? undefined); // just here for syntax checker
}

export function playerForActor(actor: Actor | undefined): User | undefined {
  if (!actor) return undefined;
  let user;
  //@ts-ignore DOCUMENT_PERMISSION_LEVELS.OWNER v10
  const OWNERSHIP_LEVELS = CONST.DOCUMENT_PERMISSION_LEVELS;
  //@ts-ignore ownership v10
  const ownwership = actor.ownership;
  // find an active user whose character is the actor
  if (actor.hasPlayerOwner) user = game.users?.find(u => u.character?.id === actor?.id && u.active);
  if (!user) // no controller - find the first owner who is active
    user = game.users?.players.find(p => p.active && ownwership[p.id ?? ""] === OWNERSHIP_LEVELS.OWNER)
  if (!user) // find a non-active owner
    user = game.users?.players.find(p => p.character?.id === actor?.id);
  if (!user) // no controlled - find an owner that is not active
    user = game.users?.players.find(p => ownwership[p.id ?? ""] === OWNERSHIP_LEVELS.OWNER)
  if (!user && ownwership.default === OWNERSHIP_LEVELS.OWNER) {
    // does anyone have default owner permission who is active
    user = game.users?.players.find(p => p.active && ownwership[p.id] === OWNERSHIP_LEVELS.INHERIT)
  }
  // if all else fails it's an active gm.
  if (!user) user = game.users?.find(p => p.isGM && p.active);
  return user;
}

//@ts-ignore dnd5e v10
export async function reactionDialog(actor: globalThis.dnd5e.documents.Actor5e, triggerTokenUuid: string | undefined, reactionItems: Item[], rollFlavor: string, triggerType: string, options: any = {}) {
  return new Promise((resolve, reject) => {
    let timeoutId = setTimeout(() => {
      dialog.close();
      resolve({});
    }, ((configSettings.reactionTimeout || 30) - 1) * 1000);
    const callback = async function (dialog, button) {
      clearTimeout(timeoutId);
      const item = reactionItems.find(i => i.id === button.key);
      if (item) {
        // await setReactionUsed(actor);
        // No need to set reaction effect since using item will do so.
        dialog.close();
        // options = mergeObject(options.workflowOptions ?? {}, {triggerTokenUuid, checkGMStatus: false}, {overwrite: true});
        options.lateTargeting = "none";
        const itemRollOptions = mergeObject(options, {
          systemCard: false,
          createWorkflow: true,
          versatile: false,
          configureDialog: true,
          checkGMStatus: false,
          targetUuids: [triggerTokenUuid],
          isReaction: true
        });
        let useTimeoutId = setTimeout(() => resolve({}), ((configSettings.reactionTimeout || 30) - 1) * 1000);
        await completeItemUse(item, {}, itemRollOptions);
        clearTimeout(useTimeoutId)
      }
      // actor.reset();
      resolve({ name: item?.name, uuid: item?.uuid })
    };

    const dialog = new ReactionDialog({
      actor,
      targetObject: this,
      title: `${actor.name}`,
      items: reactionItems,
      content: rollFlavor,
      callback,
      close: resolve,
    }, {
      width: 400
    });

    dialog.render(true);
  });
}


class ReactionDialog extends Application {
  startTime: number;
  endTime: number;

  data: {
    //@ts-ignore dnd5e v10
    actor: globalThis.dnd5e.documents.Actor5e,
    items: Item[],
    title: string,
    content: HTMLElement | JQuery<HTMLElement>,
    callback: () => {},
    close: (any) => {},
    buttons: any,
    completed: boolean
  }

  constructor(data, options) {
    super(options);
    this.startTime = Date.now();
    this.data = data;
    this.data.completed = false
  }

  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      template: "modules/midi-qol/templates/dialog.html",
      classes: ["dialog"],
      width: 150,
      height: "auto",
      jQuery: true
    });
  }
  get title() {
    return this.data.title || "Dialog";
  }
  async getData(options) {
    this.data.buttons = this.data.items.reduce((acc: {}, item: Item) => {
      acc[randomID()] = {
        icon: `<div class="item-image"> <image src=${item.img} width="50" height="50" style="margin:10px"></div>`,
        label: `${item.name}`,
        value: item.name,
        key: item.id,
        callback: this.data.callback,
      }
      return acc;
    }, {})
    return {
      content: this.data.content,
      buttons: this.data.buttons
    }
  }

  activateListeners(html) {
    html.find(".dialog-button").click(this._onClickButton.bind(this));
    $(document).on('keydown.chooseDefault', this._onKeyDown.bind(this));
    // if ( this.data.render instanceof Function ) this.data.render(this.options.jQuery ? html : html[0]);
  }

  _onClickButton(event) {
    const id = event.currentTarget.dataset.button;
    const button = this.data.buttons[id];
    debug("Reaction dialog button clicked", id, button, Date.now() - this.startTime)
    this.submit(button);
  }

  _onKeyDown(event) {
    // Close dialog
    if (event.key === "Escape" || event.key === "Enter") {
      debug("Reaction Dialog onKeyDown esc/enter pressed", event.key, Date.now() - this.startTime);
      event.preventDefault();
      event.stopPropagation();
      this.data.completed = true;
      if (this.data.close) this.data.close({ name: "keydown", uuid: undefined });
      this.close();
    }
  }

  async submit(button) {
    try {
      debug("ReactionDialog submit", Date.now() - this.startTime, button.callback)
      if (button.callback) {
        this.data.completed = true;
        await button.callback(this, button)
        this.close();
        // this.close();
      }
    } catch (err) {
      ui.notifications?.error(err);
      error(err);
      this.data.completed = false;
      this.close()
    }
  }

  async close() {
    debug("Reaction Dialog close ", Date.now() - this.startTime, this.data.completed)
    if (!this.data.completed && this.data.close) {
      this.data.close({ name: "Close", uuid: undefined });
    }
    $(document).off('keydown.chooseDefault');
    return super.close();
  }
}


export function reportMidiCriticalFlags() {
  let report: string[] = [];
  if (game?.actors) for (let a of game.actors) {
    for (let item of a.items.contents) {
      if (!["", "20", 20].includes((getProperty(item, "flags.midi-qol.criticalThreshold") || ""))) {
        report.push(`Actor ${a.name}'s Item ${item.name} has midi critical flag set ${getProperty(item, "flags.midi-qol.criticalThreshold")}`)
      }
    }
  }
  if (game?.scenes) for (let scene of game.scenes) {
    for (let tokenDocument of scene.tokens) { // TODO check this v10
      if (tokenDocument.actor) for (let item of tokenDocument.actor.items.contents) {
        if (!tokenDocument.isLinked && !["", "20", 20].includes((getProperty(item, "flags.midi-qol.criticalThreshold") || ""))) {
          report.push(`Scene ${scene.name}, Token Name ${tokenDocument.name}, Actor Name ${tokenDocument.actor.name}, Item ${item.name} has midi critical flag set ${getProperty(item, "flags.midi-qol.criticalThreshold")}`)
        }
      }
    }
  }
  console.log("Items with midi critical flags set are\n", ...(report.map(s => s + "\n")));
}

/**
 * 
 * @param actor the actor to check
 * @returns the concentration effect if present and null otherwise
 */
export function getConcentrationEffect(actor): ActiveEffect | undefined {
  let concentrationLabel: any = i18n("midi-qol.Concentrating");
  if (game.modules.get("dfreds-convenient-effects")?.active) {
    let concentrationId = "Convenient Effect: Concentrating";
    let statusEffect: any = CONFIG.statusEffects.find(se => se.id === concentrationId);
    if (statusEffect) concentrationLabel = statusEffect.name || statusEffect.label;
  } else if (game.modules.get("combat-utility-belt")?.active) {
    concentrationLabel = game.settings.get("combat-utility-belt", "concentratorConditionName")
  }
  const result = actor.effects.contents.find(i => (i.name || i.label) === concentrationLabel);
  return result;
}

function mySafeEval(expression: string, sandbox: any, onErrorReturn: boolean | undefined = undefined) {
  let result;
  try {

    const src = 'with (sandbox) { return ' + expression + '}';
    const evl = new Function('sandbox', src);
    sandbox = mergeObject(sandbox, Roll.MATH_PROXY);
    sandbox = mergeObject(sandbox, { findNearby });
    result = evl(sandbox);
  } catch (err) {
    console.warn("midi-qol | expression evaluation failed ", expression, err);
    result = onErrorReturn;
  }
  if (Number.isNumeric(result)) return Number(result)
  return result;
};

export function evalActivationCondition(workflow: Workflow, condition: string | undefined, target: Token | TokenDocument): boolean {
  if (condition === undefined || condition === "") return true;
  createConditionData({ workflow, target, actor: workflow.actor });
  const returnValue = evalCondition(condition, workflow.conditionData);
  return returnValue;
}

export function createConditionData(data: { workflow: Workflow | undefined, target: Token | TokenDocument | undefined, actor: Actor | undefined }) {
  const actor = data.workflow?.actor ?? data.actor;
  const rollData = data.workflow?.otherDamageItem?.getRollData() ?? actor?.getRollData() ?? {};

  try {
    if (data.target) {
      rollData.target = data.target.actor?.getRollData();
      if (data.target instanceof Token) rollData.targetUuid = data.target.document.uuid
      else rollData.targetUuid = data.target.uuid;
      rollData.targetId = data.target.id;
      if (rollData.target.details.type?.value) rollData.raceOrType = rollData.target.details.type?.value.toLocaleLowerCase() ?? "";
      else rollData.raceOrType = rollData.target.details.race?.toLocaleLowerCase() ?? "";
    }
    rollData.humanoid = ["human", "humanoid", "elven", "elf", "half-elf", "drow", "dwarf", "dwarven", "halfling", "gnome", "tiefling", "orc", "dragonborn", "half-orc"];
    rollData.tokenUuid = data.workflow?.tokenUuid;
    rollData.tokenId = data.workflow?.tokenId;
    rollData.workflow = {};
    rollData.effects = actor?.effects;
    rollData.workflow = {};
    if (data.workflow) {
      Object.assign(rollData.workflow, data.workflow);
      delete data.workflow.undoData;
    }
    if (data.workflow?.actor) rollData.workflow.actor = data.workflow.actor.getRollData();
    if (data.workflow?.item) rollData.workflow.item = data.workflow.item.getRollData();
    rollData.CONFIG = CONFIG;
    rollData.CONST = CONST;
  } catch (err) {

  } finally {
    if (data.workflow) data.workflow.conditionData = rollData;
  }
  return rollData;
}

export function evalCondition(condition: string, conditionData: any): boolean {
  if (condition === undefined || condition === "") return true;
  if (typeof condition !== "string") return condition;
  let returnValue;
  try {
    if (condition.includes("@")) {
      condition = Roll.replaceFormulaData(condition, conditionData, { missing: "0" });
    }
    returnValue = mySafeEval(condition, conditionData, true);
    warn("evalActivationCondition ", returnValue, condition, conditionData);

  } catch (err) {
    returnValue = true;
    console.warn(`midi-qol | activation condition (${condition}) error `, err, conditionData)
  }
  return returnValue;
}

export function computeTemplateShapeDistance(templateDocument: MeasuredTemplateDocument): { shape: string, distance: number } {
  //@ts-ignore direction etc v10
  let { direction, distance, angle, width } = templateDocument;
  if (!canvas || !canvas.scene) return { shape: "none", distance: 0 };
  const dimensions = canvas.dimensions || { size: 1, distance: 1 };
  distance *= dimensions.size / dimensions.distance;
  width *= dimensions.size / dimensions.distance;
  direction = Math.toRadians(direction);
  let shape: any;
  //@ts-ignore .t v10
  switch (templateDocument.t) {
    case "circle":
      shape = new PIXI.Circle(0, 0, distance);
      break;
    case "cone":
      //@ts-ignore
      shape = templateDocument._object._getConeShape(direction, angle, distance);
      break;
    case "rect":
      //@ts-ignore
      shape = templateDocument._object._getRectShape(direction, distance);
      break;
    case "ray":
      //@ts-ignore
      shape = templateDocument._object._getRayShape(direction, distance, width);
  }
  //@ts-ignore distance v10
  return { shape, distance: templateDocument.distance };
}

var _enableNotifications = true;

export function notificationNotify(wrapped, ...args) {
  if (_enableNotifications) return wrapped(...args);
  return;
}
export function enableNotifications(enable: boolean) {
  _enableNotifications = enable;
}

export function getConvenientEffectsReaction() {
  //@ts-ignore
  return game.dfreds?.effects?._reaction;
}

export function getConvenientEffectsBonusAction() {
  //@ts-ignore
  return game.dfreds?.effects?._bonusAction;
}
export function getConvenientEffectsUnconscious() {
  //@ts-ignore
  return game.dfreds?.effects?._unconscious;
}
export function getConvenientEffectsDead() {
  //@ts-ignore
  return game.dfreds?.effects?._dead;
}

export async function ConvenientEffectsHasEffect(effectName: string, actor: Actor, ignoreInactive: boolean = true) {
  if (ignoreInactive) {
    //@ts-ignore
    return game.dfreds.effectInterface.hasEffectApplied(effectName, actor.uuid);
  } else {
    //@ts-expect-error .label
    return actor.effects.find(ef => (ef.name || ef.label) === effectName) !== undefined;
  }
}

export function isInCombat(actor: Actor) {
  const actorUuid = actor.uuid;
  let combats;
  if (actorUuid.startsWith("Scene")) { // actor is a token synthetic actor
    const tokenId = actorUuid.split(".")[3]
    combats = game.combats?.combats.filter(combat =>
      //@ts-ignore .tokenId v10
      combat.combatants.filter(combatant => combatant?.tokenId === tokenId).length !== 0
    );
  } else { // actor is not a synthetic actor so can use actor Uuid 
    const actorId = actor.id;
    combats = game.combats?.combats.filter(combat =>
      //@ts-ignore .actorID v10
      combat.combatants.filter(combatant => combatant?.actorId === actorId).length !== 0
    );
  }
  return (combats?.length ?? 0) > 0;
}

export async function tempCEaddEffectWith(args) {
  const { effectData, origin, metaData, uuid } = args;

  if (effectData.statuses instanceof Set) {
    if (effectData.statuses.size === 0) effectData.statuses.add(effectData.flags?.core?.statusId ?? effectData.name ?? effectData.label);
    effectData.statuses = Array.from(effectData.statuses)
  } else if (effectData.statuses && effectData.statuses.length === 0 && effectData.flags?.core?.statusId) {
    effectData.statuses.push(effectData.flags?.core?.statusId)
  }
  //@ts-expect-error
  const effectInterface = game.dfreds.effectInterface;
  await effectInterface?.addEffectWith({ effectData, uuid, metaData, origin });
}

export async function setActionUsed(actor: Actor) {
  await actor.setFlag("midi-qol", "actions.action", true);
}

export async function setReactionUsed(actor: Actor) {
  if (!["all", "displayOnly"].includes(configSettings.enforceReactions) && configSettings.enforceReactions !== actor.type) return;
  let effect;
  const reactionEffect = getConvenientEffectsReaction();
  if (reactionEffect) {
    //@ts-expect-error
    const effectInterface = game.dfreds.effectInterface;
    await tempCEaddEffectWith({ effectData: reactionEffect.toObject(), uuid: actor.uuid });
    // await effectInterface?.addEffectWith({ effectData: reactionEffect.toObject(), uuid: actor.uuid });

    //@ts-ignore
    // await game.dfreds?.effectInterface.addEffect({ effectName: (getConvenientEffectsReaction().name || getConvenientEffectsReaction().label), uuid: actor.uuid });
  } //@ts-ignore
  else if (installedModules.get("combat-utility-belt") && (effect = CONFIG.statusEffects.find(se => (se.name || se.label) === i18n("DND5E.Reaction")))) {
    actor.createEmbeddedDocuments("ActiveEffect", [effect]);
  }
  await actor.setFlag("midi-qol", "actions.reactionCombatRound", game.combat?.round);
  await actor.setFlag("midi-qol", "actions.reaction", true);

}

export async function setBonusActionUsed(actor: Actor) {
  if (!["all", "displayOnly"].includes(configSettings.enforceBonusActions) && configSettings.enforceBonusActions !== actor.type) return;
  let effect;
  if (getConvenientEffectsBonusAction()) {
    //@ts-expect-error
    await game.dfreds?.effectInterface.addEffect({ effectName: (getConvenientEffectsBonusAction().name || getConvenientEffectsBonusAction().label), uuid: actor.uuid });
  } else if (installedModules.get("combat-utility-belt") && (effect = CONFIG.statusEffects.find(se => se.label === i18n("DND5E.BonusAction")))) {
    // TODO V11 check se.label
    actor.createEmbeddedDocuments("ActiveEffect", [effect]);
  }
  await actor.setFlag("midi-qol", "actions.bonusActionCombatRound", game.combat?.round);
  return actor.setFlag("midi-qol", "actions.bonus", true);
}

export async function removeActionUsed(actor: Actor) {
  return await actor?.setFlag("midi-qol", "actions.action", false);
}

export async function removeReactionUsed(actor: Actor, removeCEEffect = false) {
  if (removeCEEffect && getConvenientEffectsReaction()) {
    //@ts-expect-error
    if (await game.dfreds?.effectInterface.hasEffectApplied((getConvenientEffectsReaction().name || getConvenientEffectsReaction().label), actor.uuid)) {
      //@ts-expect-error
      await game.dfreds.effectInterface?.removeEffect({ effectName: (getConvenientEffectsReaction().name || getConvenientEffectsReaction().label), uuid: actor.uuid });
    }
  }
  if (installedModules.get("combat-utility-belt")) {
    // TODO V11 check se.label
    //@ts-expect-error
    const effect = actor.effects.contents.find(ef => (ef.name || ef.label) === i18n("DND5E.Reaction"));
    await effect?.delete();
  }
  await actor?.unsetFlag("midi-qol", "actions.reactionCombatRound");
  return actor?.setFlag("midi-qol", "actions.reaction", false);
}

export async function hasUsedAction(actor: Actor) {
  return actor?.getFlag("midi-qol", "actions.action")
}

export async function hasUsedReaction(actor: Actor) {
  // if (!["all", "displayOnly"].includes(configSettings.enforceReactions) && configSettings.enforceReactions !== actor.type) return false;
  if (actor.getFlag("midi-qol", "actions.reaction")) return true;
  if (getConvenientEffectsReaction()) {
    //@ts-expect-error .dfreds
    if (await game.dfreds?.effectInterface.hasEffectApplied((getConvenientEffectsReaction().name || getConvenientEffectsReaction().label), actor.uuid)) {
      await actor?.setFlag("midi-qol", "actions.reaction", false);
      return true;
    }
  }
  //@ts-expect-error .label
  if (installedModules.get("combat-utility-belt") && actor.effects.contents.some(ef => (ef.name || ef.label) === i18n("DND5E.Reaction"))) {
    await actor?.setFlag("midi-qol", "actions.reaction", false);
    return true;
  }
  return false;
}

export async function gmExpirePerTurnBonusActions(data: { combatUuid: string }) {
  const optionalFlagRe = /flags.midi-qol.optional.[^.]+.count$/;
  //@ts-expect-error
  const combat = fromUuidSync(data.combatUuid);
  for (let combatant of combat.turns) {
    const actor = combatant.actor;
    if (actor) {
      for (let effect of actor.effects) {
        //@ts-ignore .changes v10
        for (let change of effect.changes) {
          if (change.key.match(optionalFlagRe) && change.value === "each-turn") {
            await actor.unsetFlag("midi-qol", change.key.replace(/.count$/, ".used").replace("flags.midi-qol.", ""));
          }
        }
      }
    }
  }
}

export async function hasUsedBonusAction(actor: Actor) {
  // if (configSettings.enforceBonusActions !== "all" && configSettings.enforceBonusActions !== actor.type) return false;
  if (actor.getFlag("midi-qol", "actions.bonus")) return true;
  if (getConvenientEffectsBonusAction()) {
    //@ts-ignore
    if (await game.dfreds?.effectInterface.hasEffectApplied(getConvenientEffectsBonusAction().label, actor.uuid)) {
      await actor.setFlag("midi-qol", "actions.bonus", true);
      return true;
    }
  }
  //@ts-expect-error .label
  if (installedModules.get("combat-utility-belt") && actor.effects.contents.some(ef => (ef.name || ef.label) === i18n("DND5E.BonusAction"))) {
    await actor.setFlag("midi-qol", "actions.bonus", true);
    return true;
  }
  return false;
}

export async function removeBonusActionUsed(actor: Actor, removeCEEffect = false) {
  if (removeCEEffect && getConvenientEffectsBonusAction()) {
    //@ts-ignore
    if (await game.dfreds?.effectInterface.hasEffectApplied((getConvenientEffectsBonusAction().name || getConvenientEffectsBonusAction().label), actor.uuid)) {
      //@ts-ignore
      await game.dfreds.effectInterface?.removeEffect({ effectName: (getConvenientEffectsBonusAction().name || getConvenientEffectsBonusAction().label), uuid: actor.uuid });
    }
    if (installedModules.get("combat-utility-belt")) {
      //@ts-ignore
      const effect = actor.effects.contents.find(ef => (ef.name || ef.label) === i18n("DND5E.BonusAction"));
      await effect?.delete();
    }
  }
  await actor.setFlag("midi-qol", "actions.bonus", false);
  return  actor?.unsetFlag("midi-qol", "actions.bonusActionCombatRound");
}

export function needsReactionCheck(actor) {
  return (configSettings.enforceReactions === "all" || configSettings.enforceReactions === actor.type)
}

export function needsBonusActionCheck(actor) {
  return (configSettings.enforceBonusActions === "all" || configSettings.enforceBonusActions === actor.type)
}
export function mergeKeyboardOptions(options: any, pressedKeys: Options | undefined) {
  if (!pressedKeys) return;
  options.advantage = options.advantage || pressedKeys.advantage;
  options.disadvantage = options.disadvantage || pressedKeys.disadvantage;
  options.versatile = options.versatile || pressedKeys.versatile;
  options.other = options.other || pressedKeys.other;
  options.rollToggle = options.rollToggle || pressedKeys.rollToggle;
  options.fastForward = options.fastForward || pressedKeys.fastForward;
  options.fastForwardAbility = options.fastForwardAbility || pressedKeys.fastForwardAbility;
  options.fastForwardDamage = options.fastForwardDamage || pressedKeys.fastForwardDamage;
  options.fastForwardAttack = options.fastForwardAttack || pressedKeys.fastForwardAttack;
  options.parts = options.parts || pressedKeys.parts;
  options.critical = options.critical || pressedKeys.critical;
}

export async function asyncHooksCallAll(hook, ...args) {
  if (CONFIG.debug.hooks) {
    console.log(`DEBUG | midi-qol async Calling ${hook} hook with args:`);
    console.log(args);
  }
  //@ts-ignore
  if (!(hook in Hooks.events)) return true;

  //@ts-ignore
  for (let entry of Array.from(Hooks.events[hook])) {
    //TODO see if this might be better as a Promises.all
    try {
      //@ts-ignore
      await hookCall(entry, args);
    } catch (err) {
      error(`hooked function for hook ${hook} threw `, err)
    }
  }
  return true;
}

export async function asyncHooksCall(hook, ...args) {
  if (CONFIG.debug.hooks) {
    console.log(`DEBUG | midi-qol async Calling ${hook} hook with args:`);
    console.log(args);
  }
  //@ts-ignore Hooks.events v10
  if (!(hook in Hooks.events)) return true;

  //@ts-ignore
  for (let entry of Array.from(Hooks.events[hook])) {
    let callAdditional;
    try {
      //@ts-ignore
      callAdditional = await hookCall(entry, args);
    } catch (err) {
      error(`hooked function for hook ${hook} threw `, err);
      callAdditional = true;
    }
    if (callAdditional === false) return false;
  }
  return true;
}
function hookCall(entry, args) {
  const { hook, id, fn, once } = entry;
  if (once) Hooks.off(hook, id);
  try {
    return entry.fn(...args);
  } catch (err) {
    const msg = `Error thrown in hooked function '${fn?.name}' for hook '${hook}'`;
    console.warn(`${vtt} | ${msg}`);
    //@ts-ignore Hooks.onError v10
    if (hook !== "error") Hooks.onError("Hooks.#call", err, { msg, hook, fn, log: "error" });
  }
}

export function addAdvAttribution(html: any, advAttribution: Set<string>) {
  // <section class="tooltip-part">
  let advHtml: string = "";
  if (advAttribution && advAttribution.size > 0) {
    advHtml = Array.from(advAttribution).reduce((prev, s) => prev += `${s}<br>`, "");
    html = html.replace(`<section class="tooltip-part">`, `<section class="tooltip-part">${advHtml}`);
  }
  return html;
}

export async function midiRenderRoll(roll: Roll | undefined) {
  if (!roll) return "";
  switch (configSettings.rollAlternate) {
    case "formula":
    case "formulaadv": return roll.render({ template: "modules/midi-qol/templates/rollAlternate.html" });
    case "adv":
    case "off":
    default: return roll.render(); // "off"
  }
}
export function heightIntersects(targetDocument: any /*TokenDocument*/, flankerDocument: any /*TokenDocument*/): boolean {
  const targetElevation = targetDocument.elevation ?? 0;
  const flankerElevation = flankerDocument.elevation ?? 0;
  const targetTopElevation = targetElevation + Math.max(targetDocument.height, targetDocument.width) * (canvas?.dimensions?.distance ?? 5);
  const flankerTopElevation = flankerElevation + Math.min(flankerDocument.height, flankerDocument.width) * (canvas?.dimensions?.distance ?? 5); // assume t2 is trying to make itself small
  /* This is for requiring the centers to intersect the height range 
     Which is an alternative rule possiblity
  const flankerCenter = (flankerElevation + flankerTopElevation) / 2;
  if (flankerCenter >= targetElevation || flankerCenter <= targetTopElevation) return true;
  return false;
  */
  if (flankerTopElevation < targetElevation || flankerElevation > targetTopElevation) return false;
  return true;
}

export async function computeFlankedStatus(target): Promise<boolean> {
  if (!checkRule("checkFlanking") || !["ceflanked", "ceflankedNoconga"].includes(checkRule("checkFlanking"))) return false;
  if (!canvas || !target) return false;
  const allies: any /*Token v10*/[] = findNearby(-1, target, (canvas?.dimensions?.distance ?? 5));
  if (allies.length <= 1) return false; // length 1 means no other allies nearby
  if (canvas?.grid?.grid instanceof SquareGrid) {
    let gridW = canvas?.grid?.w ?? 100;
    let gridH = canvas?.grid?.h ?? 100;
    const tl = { x: target.x, y: target.y };
    const tr = { x: target.x + target.document.width * gridW, y: target.y };
    const bl = { x: target.x, y: target.y + target.document.height * gridH };
    const br = { x: target.x + target.document.width * gridW, y: target.y + target.document.height * gridH };
    const top: [x0: number, y0: number, x1: number, y1: number] = [tl.x, tl.y, tr.x, tr.y];
    const bottom: [x0: number, y0: number, x1: number, y1: number] = [bl.x, bl.y, br.x, br.y];
    const left: [x0: number, y0: number, x1: number, y1: number] = [tl.x, tl.y, bl.x, bl.y];
    const right: [x0: number, y0: number, x1: number, y1: number] = [tr.x, tr.y, br.x, br.y];

    while (allies.length > 1) {
      const token = allies.pop();
      if (!token) break;
      if (!heightIntersects(target.document, token.document)) continue;
      if (checkRule("checkFlanking") === "ceflankedNoconga" && installedModules.get("dfreds-convenient-effects")) {
        //@ts-ignore
        const CEFlanked = game.dfreds.effects._flanked;
        //@ts-ignore
        const hasFlanked = token.actor && CEFlanked && await game.dfreds.effectInterface?.hasEffectApplied(CEFlanked.label, token.actor.uuid);
        if (hasFlanked) continue;
      }
      // Loop through each square covered by attacker and ally
      const tokenStartX = token.document.width >= 1 ? 0.5 : token.document.width / 2;
      const tokenStartY = token.document.height >= 1 ? 0.5 : token.document.height / 2;
      for (let ally of allies) {
        if (ally.document.uuid === token.document.uuid) continue;
        const actor: any = ally.actor;
        if (actor?.system.attrbutes?.hp?.value <= 0) continue;
        if (!heightIntersects(target.document, ally.document)) continue;
        if (installedModules.get("dfreds-convenient-effects")) {
          //@ts-ignore
          if (actor?.effects.some(ef => (ef.name || ef.label) === (game.dfreds.effects._incapacitated.name || game.dfreds.effects._incapacitated.label))) continue;
        }
        if (checkRule("checkFlanking") === "ceflankedNoconga" && installedModules.get("dfreds-convenient-effects")) {
          //@ts-ignore
          const CEFlanked = game.dfreds.effects._flanked;
          //@ts-ignore
          const hasFlanked = CEFlanked && await game.dfreds.effectInterface?.hasEffectApplied((CEFlanked.name || CEFlanked.label), ally.actor.uuid);
          if (hasFlanked) continue;
        }
        const allyStartX = ally.document.width >= 1 ? 0.5 : ally.document.width / 2;
        const allyStartY = ally.document.height >= 1 ? 0.5 : ally.document.height / 2;
        var x, x1, y, y1, d, r;
        for (x = tokenStartX; x < token.document.width; x++) {
          for (y = tokenStartY; y < token.document.height; y++) {
            for (x1 = allyStartX; x1 < ally.document.width; x1++) {
              for (y1 = allyStartY; y1 < ally.document.height; y1++) {
                let tx = token.x + x * gridW;
                let ty = token.y + y * gridH;
                let ax = ally.x + x1 * gridW;
                let ay = ally.y + y1 * gridH;
                const rayToCheck = new Ray({ x: tx, y: ty }, { x: ax, y: ay });
                // console.error("Checking ", tx, ty, ax, ay, token.center, ally.center, target.center)
                const flankedTop = rayToCheck.intersectSegment(top) && rayToCheck.intersectSegment(bottom);
                const flankedLeft = rayToCheck.intersectSegment(left) && rayToCheck.intersectSegment(right);
                if (flankedLeft || flankedTop) {
                  return true;
                }
              }
            }
          }
        }
      }
    }
  } else if (canvas?.grid?.grid instanceof HexagonalGrid) {
    return false;
  }
  return false;
}

export function computeFlankingStatus(token, target): boolean {
  if (!checkRule("checkFlanking") || checkRule("checkFlanking") === "off") return false;
  if (!canvas) return false;
  if (!token) return false;
  // For the target see how many square between this token and any friendly targets
  // Find all tokens hostile to the target
  if (!target) return false;
  if (!heightIntersects(target.document, token.document)) return false;
  if (getDistance(token, target, true) > (canvas?.dimensions?.distance ?? 5)) return false;
  // an enemy's enemies are my friends.
  const allies: any /* Token v10 */[] = findNearby(-1, target, (canvas?.dimensions?.distance ?? 5));

  if (!token.document.disposition) return false; // Neutral tokens can't get flanking
  if (allies.length <= 1) return false; // length 1 means no other allies nearby

  if (canvas?.grid?.grid instanceof SquareGrid) {
    let gridW = canvas?.grid?.w ?? 100;
    let gridH = canvas?.grid?.h ?? 100;
    const tl = { x: target.x, y: target.y };
    const tr = { x: target.x + target.document.width * gridW, y: target.y };
    const bl = { x: target.x, y: target.y + target.document.height * gridH };
    const br = { x: target.x + target.document.width * gridW, y: target.y + target.document.height * gridH };
    const top: [x0: number, y0: number, x1: number, y1: number] = [tl.x, tl.y, tr.x, tr.y];
    const bottom: [x0: number, y0: number, x1: number, y1: number] = [bl.x, bl.y, br.x, br.y];
    const left: [x0: number, y0: number, x1: number, y1: number] = [tl.x, tl.y, bl.x, bl.y];
    const right: [x0: number, y0: number, x1: number, y1: number] = [tr.x, tr.y, br.x, br.y];

    // Loop through each square covered by attacker and ally
    const tokenStartX = token.document.width >= 1 ? 0.5 : token.document.width / 2;
    const tokenStartY = token.document.height >= 1 ? 0.5 : token.document.height / 2;


    for (let ally of allies) {
      if (ally.document.uuid === token.document.uuid) continue;
      if (!heightIntersects(ally.document, target.document)) continue;
      const actor: any = ally.actor;
      if (checkIncapacitated(actor, undefined, undefined)) continue;
      if (installedModules.get("dfreds-convenient-effects")) {
        //@ts-ignore
        if (actor?.effects.some(ef => ef.label === (game.dfreds.effects._incapacitated.name || game.dfreds.effects._incapacitated.label))) continue;
      }

      const allyStartX = ally.document.width >= 1 ? 0.5 : ally.document.width / 2;
      const allyStartY = ally.document.height >= 1 ? 0.5 : ally.document.height / 2;
      var x, x1, y, y1, d, r;
      for (x = tokenStartX; x < token.document.width; x++) {
        for (y = tokenStartY; y < token.document.height; y++) {
          for (x1 = allyStartX; x1 < ally.document.width; x1++) {
            for (y1 = allyStartY; y1 < ally.document.height; y1++) {
              let tx = token.x + x * gridW;
              let ty = token.y + y * gridH;
              let ax = ally.x + x1 * gridW;
              let ay = ally.y + y1 * gridH;
              const rayToCheck = new Ray({ x: tx, y: ty }, { x: ax, y: ay });
              // console.error("Checking ", tx, ty, ax, ay, token.center, ally.center, target.center)
              const flankedTop = rayToCheck.intersectSegment(top) && rayToCheck.intersectSegment(bottom);
              const flankedLeft = rayToCheck.intersectSegment(left) && rayToCheck.intersectSegment(right);
              if (flankedLeft || flankedTop) {
                return true;
              }
            }
          }
        }
      }
    }
  } else if (canvas?.grid?.grid instanceof HexagonalGrid) {
    let grid: HexagonalGrid = canvas?.grid?.grid;
    const tokenRowCol = grid.getGridPositionFromPixels(token.center.x, token.center.y);
    const targetRowCol = grid.getGridPositionFromPixels(target.center.x, target.center.y);
    const allAdjacent: [number, number][] = [];
    for (let ally of allies) {
      let allyRowCol = grid?.getGridPositionFromPixels(ally.center.x, ally.center.y);
    }
    return false;
  }
  return false;
}


export async function markFlanking(token, target): Promise<boolean> {
  // checkFlankingStatus requires a flanking token (token) and a target
  // checkFlankedStatus requires only a target token
  if (!canvas) return false;
  let needsFlanking = false;
  if (!target || !checkRule("checkFlanking") || checkRule["checkFlanking"] === "off") return false;
  if (["ceonly", "ceadv"].includes(checkRule("checkFlanking"))) {
    if (!token) return false;
    needsFlanking = computeFlankingStatus(token, target);
    if (installedModules.get("dfreds-convenient-effects")) {
      //@ts-ignore
      const CEFlanking = game.dfreds.effects._flanking;
      if (!CEFlanking) return needsFlanking;
      //@ts-ignore
      const hasFlanking = token.actor && await game.dfreds.effectInterface?.hasEffectApplied(CEFlanking.label, token.actor.uuid)
      if (needsFlanking && !hasFlanking && token.actor) {
        //@ts-ignore
        await game.dfreds.effectInterface?.addEffect({ effectName: (CEFlanking.name || CEFlanking.label), uuid: token.actor.uuid });
      } else if (!needsFlanking && hasFlanking && token.actor) {
        //@ts-ignore
        await game.dfreds.effectInterface?.removeEffect({ effectName: (CEFlanking.name || CEFlanking.label), uuid: token.actor.uuid });
      }
    }
  } else if (checkRule("checkFlanking") === "advonly") {
    if (!token) return false;
    needsFlanking = computeFlankingStatus(token, target);
  } else if (["ceflanked", "ceflankedNoconga"].includes(checkRule("checkFlanking"))) {
    if (!target.actor) return false;
    if (installedModules.get("dfreds-convenient-effects")) {
      //@ts-ignore
      const CEFlanked = game.dfreds.effects._flanked;
      if (!CEFlanked) return false;
      const needsFlanked = await computeFlankedStatus(target);
      //@ts-ignore
      const hasFlanked = target.actor && await game.dfreds.effectInterface?.hasEffectApplied((CEFlanked.name || CEFlanked.label), target.actor.uuid);
      if (needsFlanked && !hasFlanked && target.actor) {
        //@ts-ignore
        await game.dfreds.effectInterface?.addEffect({ effectName: (CEFlanked.name || CEFlanked.label), uuid: target.actor.uuid });
      } else if (!needsFlanked && hasFlanked && token.actor) {
        //@ts-ignore
        await game.dfreds.effectInterface?.removeEffect({ effectName: (CEFlanked.name || CEFlanked.label), uuid: target.actor.uuid });
      }
      return false;
    }
  }
  return needsFlanking;
}

export async function checkflanking(user: User, target: Token, targeted: boolean): Promise<boolean> {
  if (user !== game.user) return false;
  let token = canvas?.tokens?.controlled[0];
  if (user.targets.size === 1) return markFlanking(token, target);
  return false

}

export function getChanges(actorOrItem, key: string) {
  return actorOrItem.effects.contents
    .flat()
    .map(e => e.changes)
    .flat()
    .filter(c => c.key.includes(key))
    .sort((a, b) => a.key < b.key ? -1 : 1)
}

/**
 * 
 * @param token 
 * @param target 
 * 
 * @returns {boolean}
 */

export function canSense(tokenEntity: Token | TokenDocument, targetEntity: Token | TokenDocument): boolean {
  //@ts-ignore
  let target: Token = targetEntity instanceof TokenDocument ? targetEntity.object : targetEntity;
  //@ts-ignore
  let token: Token = tokenEntity instanceof TokenDocument ? tokenEntity.object : tokenEntity;
  if (!token || !target) return true;
  if (!token.hasSight) return true;
  if (!token.vision.active) {
    const sourceId = token.sourceId;
    token.vision.initialize({
      x: token.center.x,
      y: token.center.y,
      //@ts-expect-error
      radius: Math.clamped(token.sightRange, 0, canvas?.dimensions?.maxR ?? 0),
      //@ts-expect-error
      externalRadius: Math.max(token.mesh.width, token.mesh.height) / 2,
      //@ts-expect-error
      angle: token.document.sight.angle,
      //@ts-expect-error
      contrast: token.document.sight.contrast,
      //@ts-expect-error
      saturation: token.document.sight.saturation,
      //@ts-expect-error
      brightness: token.document.sight.brightness,
      //@ts-expect-error
      attenuation: token.document.sight.attenuation,
      //@ts-expect-error
      rotation: token.document.rotation,
      //@ts-expect-error
      visionMode: token.document.sight.visionMode,
      //@ts-expect-error
      color: globalThis.Color.from(token.document.sight.color),
      //@ts-expect-error
      isPreview: !!token._original,
      //@ts-expect-error specialStatusEffects
      blinded: token.document.hasStatusEffect(CONFIG.specialStatusEffects.BLIND)
    });
    //@ts-expect-error
    canvas?.effects?.visionSources.set(sourceId, token.vision);
    if (!token.vision.los && game.modules.get("perfect-vision")?.active) {
      error(`canSense los not calcluated. Can't check if ${token.name} can see ${target.name}`, token.vision);
      return true;
    }
    // Seems we Don't need to do this on the GM side - return await socketlibSocket.executeAsGM("canSense", { tokenUuid: token.document.uuid, targetUuid: target.document.uuid })
  }
  //@ts-expect-error specialStatusEffects
  const specialStatuses = CONFIG.specialStatusEffects;

  // Determine the array of offset points to test
  const t = Math.min(target.w, target.h) / 4;
  const targetPoint = target.center;
  const offsets = t > 0 ? [[0, 0], [-t, -t], [-t, t], [t, t], [t, -t], [-t, 0], [t, 0], [0, -t], [0, t]] : [[0, 0]];
  const tests = offsets.map(o => ({
    point: new PIXI.Point(targetPoint.x + o[0], targetPoint.y + o[1]),
    los: new Map()
  }));
  const config = { tests, object: targetEntity };

  // First test basic detection for light sources which specifically provide vision
  //@ts-ignore
  for (const lightSource of canvas?.effects?.lightSources.values() ?? []) {
    if (/*!lightSource.data.vision ||*/ !lightSource.active || lightSource.disabled) continue;
    const result = lightSource.testVisibility(config);
    if (result === true) return true;
  }

  //@ts-ignore
  const tokenDetectionModes = token.detectionModes;
  //@ts-ignore
  const modes = CONFIG.Canvas.detectionModes;
  //@ts-ignore v10
  const DetectionModeCONST = DetectionMode;
  const basic = tokenDetectionModes.find(m => m.id === DetectionModeCONST.BASIC_MODE_ID);
  if (basic /*&& token.vision.active*/) {
    const result = modes.basicSight.testVisibility(token.vision, basic, config);
    if (result === true) return true;
  }

  for (const detectionMode of tokenDetectionModes) {
    if (detectionMode.id === DetectionModeCONST.BASIC_MODE_ID) continue;
    if (!detectionMode.enabled) continue;
    const dm = modes[detectionMode.id];
    const result = dm?.testVisibility(token.vision, detectionMode, config)
    if (result === true) {
      return true;
    }
  }
  return false;
}
export function getSystemCONFIG(): any {
  switch (game.system.id) {
    //@ts-ignore .
    case "dnd5e": return CONFIG.DND5E;
    //@ts-ignore .
    case "sw5e": return CONFIG.DND5E;
    //@ts-ignore .
    case "n5e": return CONFIG.N5E;
    default: return {};
  }
}

export function tokenForActor(actor): Token | undefined {
  // if (actor.token) return actor.token;
  const tokens = actor.getActiveTokens();
  if (!tokens.length) return undefined;
  const controlled = tokens.filter(t => t._controlled);
  return controlled.length ? controlled.shift() : tokens.shift();
}

export async function doMidiConcentrationCheck(actor, saveDC) {
  if (configSettings.noConcnetrationDamageCheck) return;
  const itemData = duplicate(itemJSONData);
  setProperty(itemData, "system.save.dc", saveDC);
  setProperty(itemData, "system.save.ability", "con");
  setProperty(itemData, "system.save.scaling", "flat");
  setProperty(itemData, "name", concentrationCheckItemDisplayName);
  setProperty(itemData, "system.target.type", "self");
  return await doConcentrationCheck(actor, itemData)
}

export async function doConcentrationCheck(actor, itemData) {
  let result;
  // actor took damage and is concentrating....
  const saveTargets = game.user?.targets;
  const theTargetToken = getSelfTarget(actor);
  const theTarget = theTargetToken?.document.id;
  if (game.user && theTarget) game.user.updateTokenTargets([theTarget]);
  let ownedItem: Item = new CONFIG.Item.documentClass(itemData, { parent: actor })
  if (configSettings.displaySaveDC) {
    //@ts-ignore 
    ownedItem.getSaveDC()
  }
  try {
    //@ts-ignore version v10
    if (installedModules.get("betterrolls5e") && isNewerVersion(game.modules.get("betterrolls5e")?.version ?? "", "1.3.10")) { // better rolls breaks the normal roll process
      //@ts-ignore
      // await ownedItem.roll({ vanilla: false, systemCard: false, createWorkflow: true, versatile: false, configureDialog: false })
      await globalThis.BetterRolls.rollItem(ownedItem, { itemData: ownedItem.toObject(), vanilla: false, adv: 0, disadv: 0, midiSaveDC: saveDC, workflowOptions: { lateTargeting: "none" } }).toMessage();
    } else {
      //@ts-ignore
      result = await completeItemUse(ownedItem, {}, { systemCard: false, createWorkflow: true, versatile: false, configureDialog: false, workflowOptions: { lateTargeting: "none" } })
    }
  } finally {
    if (saveTargets && game.user) game.user.targets = saveTargets;
    return result;
  }
}

export function hasDAE(workflow: Workflow) {
  return installedModules.get("dae") && (
    workflow.item?.effects?.some(ef => ef?.transfer === false)
    || workflow.ammo?.effects?.some(ef => ef?.transfer === false)
  );
}

export function procActorSaveBonus(actor: Actor, rollType: string, item: Item): number {
  if (!item) return 0;
  //@ts-expect-error
  const bonusFlags = actor.system.bonuses?.save;
  if (!bonusFlags) return 0;
  let saveBonus = 0;
  if (bonusFlags.magic) {

    return 0;
  }
  if (bonusFlags.spell) {
    return 0;
  }
  if (bonusFlags.weapon) {
    return 0;
  }
  return 0;
}


export async function displayDSNForRoll(roll: Roll | undefined, rollType: string | undefined, defaultRollMode: string | undefined = undefined) {
  if (!roll) return;
  /*
  "midi-qol.hideRollDetailsOptions": {
    "none": "None",
    "detailsDSN": "Roll Formula but show DSN roll",
    "details": "Roll Formula",
    "d20Only": "Show attack D20 + Damage total",
    "hitDamage": "Show Hit/Miss + damage total",
    "hitCriticalDamage": "Show Hit/Miss/Critical/Fumble + damage total",
    "d20AttackOnly": "Show attack D20 Only",
    "all": "Entire Roll"
  },*/
  if (dice3dEnabled()) {
    //@ts-expect-error game.dice3d
    const dice3d = game.dice3d;
    const hideRollOption = configSettings.hideRollDetails;
    let ghostRoll = false;
    let whisperIds: User[] | null = null;
    const rollMode = defaultRollMode || game.settings.get("core", "rollMode");
    let hideRoll = (["all"].includes(hideRollOption) && game.user?.isGM) ? true : false;
    if (!game.user?.isGM) hideRoll = false;
    else if (hideRollOption !== "none") {
      if (configSettings.gmHide3dDice && game.user?.isGM) hideRoll = true;
      if (game.user?.isGM && !hideRoll) {
        switch (rollType) {
          case "attackRollD20":
            if (["d20Only", "d20AttackOnly", "detailsDSN"].includes(hideRollOption)) {
              for (let i = 1; i < roll.dice.length; i++) { // hide everything except the d20
                roll.dice[i].results.forEach(r => setProperty(r, "hidden", true));
              }
              hideRoll = false;
            } else if ((["hitDamage", "all", "hitCriticalDamage", "details"].includes(hideRollOption) && game.user?.isGM))
              hideRoll = true;
            break;
          case "attackRoll":
            hideRoll = hideRollOption !== "detailsDSN";
            break;
          case "damageRoll":
            hideRoll = hideRollOption !== "detailsDSN";
            break;
          default:
            hideRoll = false;
            break;
        }
      }
    }
    if (hideRoll && configSettings.ghostRolls && game.user?.isGM && !configSettings.gmHide3dDice) {
      ghostRoll = true;
      hideRoll = false;
    } else {
      ghostRoll = rollMode === "blindroll";
    }

    if (rollMode === "selfroll" || rollMode === "gmroll" || rollMode === "blindroll") {
      whisperIds = ChatMessage.getWhisperRecipients("GM");
      if (rollMode !== "blindroll" && game.user) whisperIds.concat(game.user);
    }
    if (!hideRoll) {
      let displayRoll = deepClone(roll);
      displayRoll.terms.forEach(term => {
        if (term.options?.flavor) term.options.flavor = term.options.flavor.toLocaleLowerCase();
      });
      if (ghostRoll) {
        const promises: Promise<any>[] = [];
        promises.push(dice3d?.showForRoll(displayRoll, game.user, true, ChatMessage.getWhisperRecipients("GM"), !game.user?.isGM));
        //@ts-expect-error .ghost
        displayRoll.ghost = true;
        promises.push(dice3d?.showForRoll(displayRoll, game.user, true, game.users?.players.map(u => u.id), game.user?.isGM));
        await Promise.allSettled(promises);
      } else
        await dice3d?.showForRoll(displayRoll, game.user, true, whisperIds, rollMode === "blindroll" && !game.user?.isGM)
    }
  }
  //mark all dice as shown - so that toMessage does not trigger additional display on other clients
  roll.dice.forEach(d => d.results.forEach(r => setProperty(r, "hidden", true)));
}

export function isReactionItem(item): boolean {
  if (!item) return false;
  return item.system.activation?.type?.includes("reaction");
}

export function getCriticalDamage() {
  return game.user?.isGM ? criticalDamageGM : criticalDamage;
}