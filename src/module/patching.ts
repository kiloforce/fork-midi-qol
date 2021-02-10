import { log, warn, debug, i18n, error } from "../midi-qol";
import { Workflow, noKeySet } from "./workflow";
import { doItemRoll, doAttackRoll, doDamageRoll } from "./itemhandling";
import { configSettings, autoFastForwardAbilityRolls } from "./settings.js";
import { testKey } from "./utils";
import { installedModules } from "./setupModules";


function restrictVisibility() {
  // Tokens
  for ( let t of canvas.tokens.placeables ) {
    // ** TP  t.visible = ( !this.tokenVision && !t.data.hidden ) || t.isVisible;
    // t.visible = ( !this.tokenVision && !t.data.hidden ) || t.isVisible;
    // t.visalbe = t.visible || (t.data.stealth && t.actor?.hasPerm(game.user, "OBSERVER"));
    t.visible = ( !this.tokenVision && !t.data.hidden ) || t.isVisible || (t.actor?.hasPerm(game.user, "OWNER"));
  }

  // Door Icons
  for ( let d of canvas.controls.doors.children ) {
    d.visible = !this.tokenVision || d.isVisible;
  }

  // Dispatch a hook that modules can use
  Hooks.callAll("sightRefresh", this);
}
function _getUsageUpdates(wrapped, {consumeQuantity=false, consumeRecharge=false, consumeResource=false, consumeSpellSlot=false, consumeUsage=false}) {
  const updates = wrapped({consumeQuantity, consumeRecharge, consumeResource, consumeSpellSlot, consumeUsage})
  const itemData = this.data.data;
  console.error("In my get Usage Updates", itemData.materials, itemData.components, itemData.materials?.consumed, itemData.components?.material, updates)

  if (updates && this.type === "spell" && 
       itemData.components?.material && itemData.materials?.cost > 0) {
    const supplyAvailable = itemData.materials.supply ?? 0;
    console.error("supply", supplyAvailable, itemData.materials.supply)
    if (supplyAvailable < 1) {
      ui.notifications.warn(`MidiQOL: No ${itemData.materials.value} available`)
      return false;
    }
    if (itemData.materials?.consumed)
      updates.itemUpdates["data.materials.supply"] = supplyAvailable - 1;
  }
  return updates;
}

function _isVisionSource() {
  // log("proxy _isVisionSource", this);

  if ( !canvas.sight.tokenVision || !this.hasSight ) return false;

  // Only display hidden tokens for the GM
  const isGM = game.user.isGM;
  // TP insert
  // console.error("is vision source ", this.actor?.name, this.actor?.hasPerm(game.user, "OWNER"))
  if (this.data.hidden && !(isGM || this.actor?.hasPerm(game.user, "OWNER"))) return false;

  // Always display controlled tokens which have vision
  if ( this._controlled ) return true;

  // Otherwise vision is ignored for GM users
  if ( isGM ) return false;

  if (this.actor?.hasPerm(game.user, "OWNER")) return true;
  // If a non-GM user controls no other tokens with sight, display sight anyways
  const canObserve = this.actor && this.actor.hasPerm(game.user, "OBSERVER");
  if ( !canObserve ) return false;
  const others = canvas.tokens.controlled.filter(t => t.hasSight);
//TP ** const others = this.layer.controlled.filter(t => !t.data.hidden && t.hasSight);
  return !others.length;
}

function setVisible(visible: boolean) {
  this._isVisible = visible;
}

function isVisible() {
  // console.error("Doing my isVisible")
  const gm = game.user.isGM;
  if (this.actor?.hasPerm(game.user, "OWNER")) {
//     this.data.hidden = false;
    return true;
  } 
  if ( this.data.hidden ) return gm || this.actor?.hasPerm(game.user, "OWNER");
  if (!canvas.sight.tokenVision) return true;
  if ( this._controlled ) return true;
  const tolerance = Math.min(this.w, this.h) / 4;
  return canvas.sight.testVisibility(this.center, {tolerance});
}

export const advantageEvent = {shiftKey: true, altKey: true, ctrlKey: false, metaKey: false};
export const disadvantageEvent = {shiftKey: true, altKey:false, ctrlKey: true, metaKey: true};
export const fastforwardEvent = {shiftKey: true, altKey:false, ctrlKey: false, metaKey: false};
export const baseEvent = {shiftKey: false, altKey:false, ctrlKey: false, metaKey: false};

function mapSpeedKeys(event) {
  if (configSettings.speedItemRolls && configSettings.speedAbilityRolls) {
    if (game.system.id === "sw5e")  {
      var advKey = testKey(configSettings.keyMapping["SW5E.Advantage"], event);
      var disKey = testKey(configSettings.keyMapping["SW5E.Disadvantage"], event);
    } else {
      var advKey = testKey(configSettings.keyMapping["DND5E.Advantage"], event);
      var disKey = testKey(configSettings.keyMapping["DND5E.Disadvantage"], event);
    }
    const fastFowrd = advKey && disKey;
    if (fastFowrd) event = fastforwardEvent;
    else if (disKey) event = disadvantageEvent;
    else if (advKey) event = advantageEvent;
    else event = baseEvent;
  }
  return event;
}

function doRollSkill(wrapped, ...args) {
  const [ skillId, options={event: {}, parts: []} ] = args;
  options.event = mapSpeedKeys(options.event);
  let opt = {event: {}}
  procAdvantage(this, "check", this.data.data.skills[skillId].ability, opt)
  let opt2 = {event: {}};
  procAdvantageSkill(this, skillId, opt2)
  //@ts-ignore
  const withAdvantage = opt.event.altKey || opt2.event.altKey || options.event?.altKey;
  //@ts-ignore
  const withDisadvantage = opt.event.ctrlKey || opt.event.metaKey || opt2.event.ctrlKey || opt2.event.metaKey || options.event?.ctrlKey || options.event?.metaKey;
  if (withAdvantage) options.event = advantageEvent;
  else if (withDisadvantage) options.event = disadvantageEvent;
  if (withAdvantage && withDisadvantage) {
    options.event = fastforwardEvent;
  }
  if (autoFastForwardAbilityRolls && (!options?.event || noKeySet(options.event))) {
    options.event = fastforwardEvent;
  }
  if (procAutoFailSkill(this, skillId) || procAutoFail(this, "check", this.data.data.skills[skillId].ability))
  {
    options.parts = ["-100"];
  }
  return wrapped(...args);
}

function rollDeathSave(wrapped, ...args) {
  const [ options ] = args;
  const event = mapSpeedKeys(options.event);
  const advFlags = getProperty(this.data.flags, "midi-qol")?.advantage ?? {};
  const disFlags = getProperty(this.data.flags, "midi-qol")?.disadvantage ?? {};

  options.advantage = event.altKey || advFlags.deathSave || advFlags.all;
  options.disadvantage = event.ctrlKey || event.metaKey || disFlags.deathSave || disFlags.all;
  options.fastForward = event.altKey && (event.ctrklKey || options.metaKey);
  
  if (autoFastForwardAbilityRolls) options.fastForward = true;
  if (options.advantage && options.disadvantage) {
    options.advantage = options.disadvantage = false;
  }
  return wrapped(...args);
}

function doAbilityRoll(wrapped, ...args) {
  const [ abilityId, options={event} ] = args;
  warn("roll ", options.event)
  if (autoFastForwardAbilityRolls && (!options?.event || noKeySet(options.event))) {
    //@ts-ignore
    // options.event = mergeObject(options.event, {shiftKey: true}, {overwrite: true, inplace: true})
    options.event = fastforwardEvent;
  }
  return wrapped(...args);
}

function rollAbilityTest(wrapped, ...args)  {
  const [ abilityId, options={event: {}, parts: []} ] = args;
  if (procAutoFail(this, "check", abilityId)) options.parts = ["-100"];
  options.event = mapSpeedKeys(options.event);
  procAdvantage(this, "check", abilityId, options);
  return doAbilityRoll.call(this, wrapped, ...args);
}

function rollAbilitySave(wrapped, ...args)  {
  const [ abilityId, options={event: {}, parts: []} ] = args;
  if (procAutoFail(this, "save", abilityId)) {
    options.parts = ["-100"];
  }
  options.event = mapSpeedKeys(options.event);
  procAdvantage(this, "save", abilityId, options);
  return doAbilityRoll.call(this, wrapped, ...args);
}

function procAutoFail(actor, rollType, abilityId) {
  const midiFlags = actor.data.flags["midi-qol"] ?? {};
  const fail = midiFlags.fail ?? {};
  if (fail.ability || fail.all) {
    const rollFlags = (fail.ability && fail.ability[rollType]) ?? {};
    const autoFail = fail.all || fail.ability.all || rollFlags.all || rollFlags[abilityId];
    return autoFail;
  }
  return false;
}
function procAutoFailSkill(actor, skillId) {
  const midiFlags = actor.data.flags["midi-qol"] ?? {};
  const fail = midiFlags.fail ?? {};
  console.error("skill roll ", fail, skillId)
  if (fail.skill || fail.all) {
    const rollFlags = (fail.skill && fail.skill[skillId]) || false;
    const autoFail = fail.all || fail.skill.all || rollFlags;
    console.error("returning autofail ", autoFail, rollFlags)
    return autoFail;
  }
  return false;
}

function procAdvantage(actor, rollType, abilityId, options) {
  const midiFlags = actor.data.flags["midi-qol"] ?? {};
  const advantage = midiFlags.advantage ?? {};
  const disadvantage = midiFlags.disadvantage ?? {};
  var withAdvantage = options.event?.altKey;
  var withDisadvantage = options.event?.ctrlKey || options.event?.metaKey;;
  if (advantage.ability || advantage.all) {
    const rollFlags = (advantage.ability && advantage.ability[rollType]) ?? {};
    withAdvantage = withAdvantage || advantage.all || advantage.ability.all || rollFlags.all || rollFlags[abilityId];
    if (withAdvantage) options.event = advantageEvent;
  }
  if (disadvantage.ability || disadvantage.all) {
    const rollFlags = (disadvantage.ability && disadvantage.ability[rollType]) ?? {};
    withDisadvantage = withDisadvantage || disadvantage.all || disadvantage.ability.all || rollFlags.all || rollFlags[abilityId];
    if (withDisadvantage) options.event = disadvantageEvent
  }
  if (withAdvantage && withDisadvantage) options.event = fastforwardEvent;
  if (configSettings.speedAbilityRolls && options.event?.altKey && options.event?.crtlKey)
    options.event = baseEvent;
}

function procAdvantageSkill(actor, skillId, options) {
  const midiFlags = actor.data.flags["midi-qol"];
  const advantage = midiFlags?.advantage;
  const disadvantage = midiFlags?.disadvantage;
  var withAdvantage;
  var withDisadvantage;
  if (advantage?.skill) {
    const rollFlags = advantage.skill
    withAdvantage = advantage.all || rollFlags?.all || (rollFlags && rollFlags[skillId]);
    if (withAdvantage) options.event = advantageEvent;
  }
  if (disadvantage?.skill) {
    const rollFlags = disadvantage.skill
    withDisadvantage = disadvantage.all || rollFlags?.all || (rollFlags && rollFlags[skillId])
    if (withDisadvantage) options.event = disadvantageEvent;
  }
  if (withAdvantage && withDisadvantage) options.event = fastforwardEvent;
}

export let visionPatching = () => {
  const patchVision = isNewerVersion(game.data.version, "0.7.0") && game.settings.get("midi-qol", "playerControlsInvisibleTokens")
  if (patchVision) {
    // ui.notifications.warn("This setting is deprecated please switch to Conditional Visibility")
    console.warn("midi-qol | Player controls tokens setting is deprecated please switch to Conditional Visibility")
    if (game.modules.get("lib-wrapper")?.active) {
      log("Patching SightLayer._restrictVisibility")
      //@ts-ignore
      libWrapper.register("midi-qol", "SightLayer.prototype.restrictVisibility", restrictVisibility, "OVERRIDE");

      log("Patching Token._isVisionSource")
      //@ts-ignore
      libWrapper.register("midi-qol", "Token.prototype._isVisionSource", _isVisionSource, "OVERRIDE");

      log("Patching Token.isVisible")
      //@ts-ignore
      libWrapper.register("midi-qol", "Token.prototype.isVisible", isVisible, "OVERRIDE");
    } else {
      log("Patching SightLayer._restrictVisibility")
      //@ts-ignore
      let restrictVisibilityProxy = new Proxy(SightLayer.prototype.restrictVisibility, {
        apply: (target, thisvalue, args) =>
            restrictVisibility.bind(thisvalue)(...args)
      })
      //@ts-ignore
      SightLayer.prototype.restrictVisibility = restrictVisibilityProxy;

      log("Patching Token._isVisionSource")
      //@ts-ignore
      let _isVisionSourceProxy = new Proxy(Token.prototype._isVisionSource, {
        apply: (target, thisvalue, args) =>
        _isVisionSource.bind(thisvalue)(...args)
      })
      //@ts-ignore
      Token.prototype._isVisionSource = _isVisionSourceProxy;

      log("Patching Token.isVisible")
      Object.defineProperty(Token.prototype, "isVisible", { get: isVisible });
    }
  }
  log("Vision patching - ", patchVision ? "enabled" : "disabled")
}

export let itemPatching = () => {

  let ItemClass = CONFIG.Item.entityClass;
  let ActorClass = CONFIG.Actor.entityClass;

  
const rollMappings = {
  //@ts-ignore
  "itemRoll" : {roll: ItemClass.prototype.roll, methodName: "roll", class: CONFIG.Item.entityClass, target: "CONFIG.Item.entityClass.prototype.roll", replacement: doItemRoll},
  //@ts-ignore
  "itemAttack": {roll: ItemClass.prototype.rollAttack, methodName: "rollAttack", class: CONFIG.Item.entityClass, target: "CONFIG.Item.entityClass.prototype.rollAttack", replacement: doAttackRoll},
  //@ts-ignore
  "itemDamage": {roll: ItemClass.prototype.rollDamage, methodName: "rollDamage", class: CONFIG.Item.entityClass, target: "CONFIG.Item.entityClass.prototype.rollDamage", replacement: doDamageRoll},
  //@ts-ignore
  // "applyDamage": {roll: ActorClass.prototype.applyDamage, class: CONFIG.Actor.entityClass, target: "CONFIG.Actor.entityClass.prototype.applyDamage"}
};
["itemAttack", "itemDamage", "itemRoll"].forEach(rollId => {
  log("Patching ", rollId, rollMappings[rollId]);
  let rollMapping = rollMappings[rollId];
  if (game.modules.get("lib-wrapper")?.active) {
    //@ts-ignore
    libWrapper.register("midi-qol", rollMapping.target, rollMapping.replacement, "MIXED");
  } else {
    const replacementMethod = rollMapping.replacement;
    const originalMethod = rollMapping.roll;
    rollMapping.class.prototype[rollMapping.methodName] = function() {
       return replacementMethod.call(this, originalMethod.bind(this), ...arguments);
    };
  }
})
debug("After patching roll mappings are ", rollMappings);
}

export let actorAbilityRollPatching = () => {
  if (game.modules.get("lib-wrapper")?.active) {
    log("Patching rollAbilitySave")
    //@ts-ignore
    libWrapper.register("midi-qol", "CONFIG.Actor.entityClass.prototype.rollAbilitySave", rollAbilitySave, "WRAPPER");

    log("Patching rollAbilityTest")
    //@ts-ignore
    libWrapper.register("midi-qol", "CONFIG.Actor.entityClass.prototype.rollAbilityTest", rollAbilityTest, "WRAPPER");

    log("Patching rollSkill");
    //@ts-ignore
    libWrapper.register("midi-qol", "CONFIG.Actor.entityClass.prototype.rollSkill", doRollSkill, "WRAPPER");

    log("Patching rollDeathSave");
    //@ts-ignore
    libWrapper.register("midi-qol", "CONFIG.Actor.entityClass.prototype.rollDeathSave", rollDeathSave, "WRAPPER");

    //@ts-ignore - not ready for release yet
    // libWrapper.register("midi-qol", "CONFIG.Item.entityClass.prototype._getUsageUpdates", _getUsageUpdates, "WRAPPER");

  } else {
    //@ts-ignore
    const oldRollAbilitySave = CONFIG.Actor.entityClass.prototype.rollAbilitySave;
    //@ts-ignore
    const oldRollAbilityTest = CONFIG.Actor.entityClass.prototype.rollAbilityTest;
    //@ts-ignore
    const oldRollSkill = CONFIG.Actor.entityClass.prototype.rollSkill;
    //@ts-ignore
    const oldRollDeathSave = CONFIG.Actor.entityClass.prototype.rollDeathSave;

    log("Patching rollAbilitySave")
    //@ts-ignore
    CONFIG.Actor.entityClass.prototype.rollAbilitySave = function () {
      return rollAbilitySave.call(this, oldRollAbilitySave.bind(this), ...arguments);
    };
    log("Patching rollAbilityTest")
    //@ts-ignore
    CONFIG.Actor.entityClass.prototype.rollAbilityTest = function () {
      return rollAbilityTest.call(this, oldRollAbilityTest.bind(this), ...arguments);
    };
    log("Patching rollSkill");
    //@ts-ignore
    CONFIG.Actor.entityClass.prototype.rollSkill = function () {
      return doRollSkill.call(this, oldRollSkill.bind(this), ...arguments);
    };
    log("Patching rollDeathSave");
    //@ts-ignore
    CONFIG.Actor.entityClass.prototype.rollDeathSave = function () {
      return rollDeathSave.call(this, oldRollDeathSave.bind(this), ...arguments);
    };
  }
}

export function patchLMRTFY() {
  if (installedModules.get("lmrtfy") && !isNewerVersion(game.modules.get("lmrtfy").data.version, "0.1.7")) {
    if (game.modules.get("lib-wrapper")?.active) {
      log("Patching rollAbilitySave")
      //@ts-ignore
      libWrapper.register("midi-qol", "LMRTFYRoller.prototype._makeRoll", _makeRoll, "OVERRIDE");
    } else {
      //@ts-ignore
      LMRTFYRoller.prototype._makeRoll = function () {
        //@ts-ignore
        return _makeRoll.call(this, LMRTFYRoller.prototype._makeRoll.bind(this), ...arguments);
      };
    };
  }
}

export function _makeRoll(event, rollMethod, ...args) {
  let options;
  switch(this.advantage) {
      case -1: 
        options = {disadvantage: true};
        break;
      case 0:
        options = {fastforward: true};
        break;
      case 1:
        options = {advantage: true};
        break;
      case 2: 
        options = {event: event}
        break;
  }
  const rollMode = game.settings.get("core", "rollMode");
  game.settings.set("core", "rollMode", this.mode || CONST.DICE_ROLL_MODES);
  for (let actor of this.actors) {
      Hooks.once("preCreateChatMessage", this._tagMessage.bind(this));
          actor[rollMethod].call(actor, ...args, options);                        
  }
  game.settings.set("core", "rollMode", rollMode);
  event.currentTarget.disabled = true;
  if (this.element.find("button").filter((i, e) => !e.disabled).length === 0)
      this.close();
}
