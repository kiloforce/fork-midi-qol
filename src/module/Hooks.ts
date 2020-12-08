import { warn, error, debug, i18n } from "../midi-qol";
import { processpreCreateBetterRollsMessage, colorChatMessageHandler, diceSoNiceHandler, nsaMessageHandler, hideStuffHandler, chatDamageButtons, processcreateBetterRollMessage, mergeCardSoundPlayer, diceSoNiceUpdateMessge, recalcCriticalDamage, processItemCardCreation, hideRollUpdate, hideRollRender } from "./chatMesssageHandling";
import { processUndoDamageCard } from "./GMAction";
import { untargetDeadTokens, untargetAllTokens, midiCustomEffect } from "./utils";
import { configSettings, dragDropTargeting } from "./settings";

export let initHooks = () => {
  warn("Init Hooks processing");
  Hooks.on("preCreateChatMessage", (data, options, user) => {
    debug("preCreateChatMessage entering", data, options, user)
    recalcCriticalDamage(data, options);
    processpreCreateBetterRollsMessage(data, options, user);
    return true;
  })

  Hooks.on("createChatMessage", (message, options, user) => {
    debug("Create Chat Meesage ", message.id, message, options, user)
    processcreateBetterRollMessage(message, options, user);
    processItemCardCreation(message, options, user);
    return true;
  })
  
  Hooks.on("updateChatMessage", (message, update, options, user) => {
    diceSoNiceUpdateMessge(message, update, options, user);
    mergeCardSoundPlayer(message, update, options, user);
    hideRollUpdate(message, update, options, user)
    //@ts-ignore
    ui.chat.scrollBottom();
  })

  Hooks.on("updateCombat", (...args) => {
    untargetAllTokens(...args);
    untargetDeadTokens();
  })
  
  Hooks.on("renderChatMessage", (message, html, data) => {
    debug("render message hook ", message.id, message, html, data);
    hideStuffHandler(message, html, data);
    chatDamageButtons(message, html, data);
    processUndoDamageCard(message, html, data);
    diceSoNiceHandler(message, html, data);
    colorChatMessageHandler(message, html, data);
    nsaMessageHandler(message, html, data);
    hideRollRender(message, html, data);
  })

  Hooks.on("applyActiveEffect", midiCustomEffect); 

  Hooks.on("renderItemSheet", (app, html, data) => {
    if (configSettings.allowUseMacro) {
      const element = html.find('input[name="data.chatFlavor"]').parent().parent();
      const labelText = i18n("midi-qol.onUseMacroLabel");
      const currentMacro = getProperty(app.object.data, "flags.midi-qol.onUseMacroName") ?? "";
      const macroField = `<div class="form-group"><label>${labelText}</label><input type="text" name="flags.midi-qol.onUseMacroName" value="${currentMacro}"/> </div>`;
      element.append(macroField)
    }
  })

  Hooks.on('dropCanvasData', function(canvas, dropData) {
    if (!dragDropTargeting) return true;
    if (dropData.type !== "Item") return true;;
    let grid_size = canvas.scene.data.grid

    canvas.tokens.targetObjects({
        x: dropData.x-grid_size/2,
        y: dropData.y-grid_size/2,
        height: grid_size,
        width: grid_size
    });

    const actor = game.actors.get(dropData.actorId);
    const item = actor && actor.items.get(dropData.data._id);
    if (!actor || !item) console.error("actor / item broke ", actor, item);
    if (item.type === "spell") {
      //@ts-ignore
      actor.useSpell(item, {configureDialog: true})
    } else {
      //@ts-ignore
      item.roll();
    }
  })
}

Hooks.on("preUpdateCombat", async (combat, update, ...args) => {
  debug("update combat ", combat, combat.turns)
  const currentTurn = (update.round ?? combat.round) * combat.turns.length + (update.turn ?? combat.turn);
  let startTurn = (combat.previous.round ?? combat.round) * combat.turns.length + (combat.previous.turn ?? combat.turn);
  // let expiredEffects = [];
  for (let checkTurn = startTurn; checkTurn <= currentTurn; checkTurn++) {
    const turn = combat.turns[checkTurn % combat.turns.length];
    let expiredEffects = turn.actor.effects?.filter(ef => 
      (ef.data.flags?.dae?.specialDuration === "turnStart") && (checkTurn > startTurn ) ||
      (ef.data.flags?.dae?.specialDuration === "turnEnd") && (checkTurn < currentTurn)
    ).map(ef => ef.id);
    if (expiredEffects?.length > 0) turn.actor.deleteEmbeddedEntity("ActiveEffect", expiredEffects);
  };
  return true;
});

Hooks.on("preDeleteCombat", (combat, options) => {
  combat.turns.forEach(async turn => {
    // Assume round/turn spells expire on completion of comabat
    let expiredEffects = turn.actor.temporaryEffects.filter(ef => ef.data.flags?.dae?.specialDuration);
    expiredEffects = expiredEffects.map(ef=>ef.id || ef.data.id);
    if (expiredEffects.length > 0) 
    { 
      await turn.actor.deleteEmbeddedEntity("ActiveEffect", expiredEffects);
      warn("Deleting effects ", turn.actor, expiredEffects);
    }
  })
});
