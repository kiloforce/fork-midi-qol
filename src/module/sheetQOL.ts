import { itemDeleteCheck, itemRollButtons, speedItemRolls } from "./settings";
import { i18n, debug, log, warn } from "../midi-qol";
import { Workflow } from "./workflow";


let knownSheets = {
  BetterNPCActor5eSheet: ".item .rollable",
  ActorSheet5eCharacter: ".item .item-image",
  BetterNPCActor5eSheetDark: ".item .rollable",
  ActorSheet5eCharacterDark: ".item .item-image",
  DarkSheet: ".item .item-image",
  ActorNPC5EDark: ".item .item-image",
  DynamicActorSheet5e: ".item .item-image",
  ActorSheet5eNPC: ".item .item-image",
  DNDBeyondCharacterSheet5e: ".item .item-name .item-image",
  Tidy5eSheet:  ".item .item-image",
  Tidy5eNPC: ".item .item-image",
  MonsterBlock5e: ".item .item-name"

//  Sky5eSheet: ".item .item-image",
};

export function setupSheetQol() {
  for (let sheetName of Object.keys(knownSheets)) {
    Hooks.on("render" + sheetName, enableSheetQOL);
  }
  Hooks.on("renderedAlt5eSheet", enableSheetQOL);
  Hooks.on("renderedTidy5eSheet", enableSheetQOL);
}

let enableSheetQOL = (app, html, data) => {
  // find out how to reinstate the original handler later.
  const defaultTag = ".item .item-image";
  //Add a check for item deletion
  if (itemDeleteCheck) {
      // remove current handler - this is a bit clunky since it results in a case with no delete handler
      $(html).find(".item-delete").off("click");
      $(html).find(".item-delete").click({ app, data: data }, itemDeleteHandler);
  }

  let rollTag = knownSheets[app.constructor.name] ? knownSheets[app.constructor.name] : defaultTag;

  if (itemRollButtons)
      addItemSheetButtons(app, html, data);

  if (speedItemRolls !== "off") {
    [".attributes", ".inventory", ".features", ".spellbook"].forEach(tab => {
      // Item Rolling do attack and damge at the same
      if (["BetterNPCActor5eSheet", "BetterNPCActor5eSheetDark"].includes(app.constructor.name)) 
        var rollTagElement = html.find(`${rollTag}`); // do not have the right nav tabs
      else
        var rollTagElement = html.find(`${tab} ${rollTag}`);

      rollTagElement.off("click");
      rollTagElement.off("click", "midi-qol", itemRollHandler);
      rollTagElement.on("click", {app, data, html}, itemRollHandler);
      rollTagElement.off("contextmenu", "midi-qol", itemRollHandler);
      rollTagElement.off("contextmenu");
      rollTagElement.on("contextmenu", { app, data, html }, itemRollHandler);
    })
  }
  return true;
};

let itemDeleteHandler = ev => {
  let actor = game.actors.get(ev.data.data.actor._id);
  let d = new Dialog({
      // localize this text
      title: i18n("midi-qol.reallyDelete"),
      content: `<p>${i18n("midi-qol.sure")}</p>`,
      buttons: {
          one: {
              icon: '<i class="fas fa-check"></i>',
              label: "Delete",
              callback: () => {
                  let li = $(ev.currentTarget).parents(".item"), itemId = li.attr("data-item-id");
                  ev.data.app.object.deleteOwnedItem(itemId);
                  li.slideUp(200, () => ev.data.app.render(false));
              }
          },
          two: {
              icon: '<i class="fas fa-times"></i>',
              label: "Cancel",
              callback: () => { }
          }
      },
      default: "two"
  });
  d.render(true);
};

async function itemRollHandler(event) {
  // Allow shift/ctl/alt from the weapon img - unshifted works as before
  //let actor = game.actors.get(event.data.data.actor._id);
  let actor;

  // If the app has a token then this is a token sheet and we want the actor inside the token
  if (event.data.app.token)
      actor = event.data.app.token.actor;
  else if (event.data.app.object)
      actor = event.data.app.object;
  // this should be defined
  else
      actor = game.actors.get(event.data.data.actor._id); // but just in case we can get the global Actor if we must

      let itemId = $(event.currentTarget).parents(".item").attr("data-item-id");
  let magicItemId = $(event.currentTarget).parents(".item").attr("data-magic-item-id")
  if (magicItemId) { // item is a magic item component TODO:find out how to do this properly.
    //@ts-ignore
    // return MagicItems.actor(actor.id).roll(magicItemId, itemId);
    return MagicItems.actor(actor.id).roll(magicItemId, itemId);
    /*mActor = MgicItems.actor(actor.id);
    //@ts-ignore
    let item = mActor.getOwnedItem(actor.getOwnedItem, itemId)
    let item = MagicItems.actor(actor.id).getOwnedItem(actor.getOwnedItem, itemId)
    warn("Item is ", item)
    return item.roll();*/

  }
  // This is for some sheets that have changed the layout.
  if (!itemId) itemId = $(event.currentTarget).attr("data-item-id");

  if (!itemId) {
    console.error("Could not find item in character sheet")
    return false;
  }
  let item = actor.getOwnedItem(itemId);
  if (item.type === "spell") {
    Workflow.eventHack = event;
    actor.useSpell(item)
  }
  else item.roll({event})
}

function addItemSheetButtons(app, html, data, triggeringElement = "", buttonContainer = "") {
  // Setting default element selectors
  if (triggeringElement === "")
      triggeringElement = ".item .item-name";

      if (["BetterNPCActor5eSheet", "BetterNPCActor5eSheetDark"].includes(app.constructor.name)) {
    triggeringElement = ".item .npc-item-name"
    buttonContainer = ".item-properties"
  }
  if (buttonContainer === "")
      buttonContainer = ".item-properties";

  // adding an event for when the description is shown
  html.find(triggeringElement).click(event => {
      let li = $(event.currentTarget).parents(".item");
      if (!li.hasClass("expanded")) return; 
      let item = app.object.getOwnedItem(li.attr("data-item-id"));
      if (!item) return;
      let actor = app.object;
      let chatData = item.getChatData();
      let targetHTML = $(event.target.parentNode.parentNode);
      let buttonTarget = targetHTML.find(".item-buttons");
      if (buttonTarget.length > 0) return; // already added buttons
      let buttonsWereAdded = false;
      // Create the buttons
      let buttons = $(`<div class="item-buttons"></div>`);
      switch (item.data.type) {
          case "weapon":
          case "spell":
          case "feat":
              if (speedItemRolls !== "off")
                  buttons.append(`<span class="tag"><button data-action="basicRoll">${i18n("midi-qol.buttons.roll")}</button></span>`);
              if (item.hasAttack)
                  buttons.append(`<span class="tag"><button data-action="attack">${i18n("midi-qol.buttons.attack")}</button></span>`);
              if (item.hasDamage)
                  buttons.append(`<span class="tag"><button data-action="damage">${i18n("midi-qol.buttons.damage")}</button></span>`);
              if (item.isVersatile) 
                  buttons.append(`<span class="tag"><button data-action="versatileAttack">${i18n("midi-qol.buttons.versatileAttack")}</button></span>`);
              if (item.isVersatile) 
                buttons.append(`<span class="tag"><button data-action="versatileDamage">${i18n("midi-qol.buttons.versatileDamage")}</button></span>`);
              buttonsWereAdded = true;
              break;
          case "consumable":
              if (chatData.hasCharges)
                  buttons.append(`<span class="tag"><button data-action="consume">${i18n("midi-qol.buttons.itemUse")} ${item.name}</button></span>`);
              buttonsWereAdded = true;
              break;
          case "tool":
              buttons.append(`<span class="tag"><button data-action="toolCheck" data-ability="${chatData.ability.value}">${i18n("midi-qol.buttons.itemUse")} ${item.name}</button></span>`);
              buttonsWereAdded = true;
              break;
      }
      if (buttonsWereAdded) {
          buttons.append(`<br><header style="margin-top:6px"></header>`);
          // adding the buttons to the sheet

          targetHTML.find(buttonContainer).prepend(buttons);
          buttons.find("button").click({app, data, html}, async (ev) =>  {
              ev.preventDefault();
              ev.stopPropagation();
              debug("roll handler ", ev.target.dataset.action);
              let event = {shiftKey: ev.shiftKey, crtilKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey};
              // If speed rolls are off
              switch (ev.target.dataset.action) {
                  case "attack":
                      await item.rollAttack({ event });
                      break;
                  case "versatileAttack":
                      await item.rollAttack({ event, versatile: true });
                      break;
                  case "damage":
                      await item.rollDamage({ event, versatile: false });
                      break;
                  case "versatileDamage":
                      await item.rollDamage({ event, versatile: true });
                      break;
                  case "consume":
                      await item.roll({ event });
                      break;
                  case "toolCheck":
                      await item.rollToolCheck({ event });
                      break;
                  case "basicRoll":
                      if (item.type === "spell") {
                        await actor.useSpell(item, { configureDialog: true });
                      }
                      else
                          await item.roll({event});
                      break;
              }
          });
      }
  });
}
