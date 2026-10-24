import { createAbilityIcon } from './ability-icon.ts'
import { abilityIconUrl } from './ability-icon-urls.ts'
import { healthReadout, respawnText, type AbilitySlotView } from './hud.ts'

export type HudInput = {
  dead: boolean
  // The controlled champion's health. Left out, the bar keeps what it last showed.
  health?: { hp: number; maxHp: number; shield: number }
  // How long until the controlled champion is back, while it is dead.
  respawnSeconds?: number
  abilities: readonly AbilitySlotView[]
}

type HudSlot = {
  root: HTMLElement
  // The picture of the ability on the key, swapped when the key's ability changes (a recast). It is
  // drawn twice: grey and dim underneath, and in full colour over it, cropped to how far the
  // cooldown has run, so the colour rises from the bottom as the ability comes back.
  icons: HTMLElement
  iconAbilityId?: string
  key: HTMLElement
  name: HTMLElement
  time: HTMLElement
}

// The bottom of the screen: the exact health with its shield, and a slot for each ability whose icon
// is grey when it is cast and fills up with colour from the bottom as the cooldown runs. Plain
// elements over the canvas, hidden until the first update.
export function createHudView(container: HTMLElement) {
  const root = document.createElement('div')
  root.className = 'game-hud'
  root.setAttribute('aria-label', 'Your health and abilities')
  root.hidden = true
  const health = document.createElement('div')
  health.className = 'hud-health'
  const healthFill = document.createElement('div')
  healthFill.className = 'hud-health-fill'
  const healthShield = document.createElement('div')
  healthShield.className = 'hud-health-shield'
  const healthText = document.createElement('div')
  healthText.className = 'hud-health-text'
  health.append(healthFill, healthShield, healthText)
  const abilities = document.createElement('div')
  abilities.className = 'hud-abilities'
  root.append(health, abilities)
  container.appendChild(root)
  const slots: HudSlot[] = []

  return {
    update(input: HudInput): void {
      root.hidden = false
      root.classList.toggle('is-dead', input.dead)
      if (input.health) {
        const readout = healthReadout(input.health)
        healthFill.style.width = `${readout.healthPercent}%`
        healthShield.style.left = `${readout.healthPercent}%`
        healthShield.style.width = `${readout.shieldPercent}%`
        healthText.textContent = readout.shield ? `${readout.health}  ${readout.shield}` : readout.health
      }
      if (input.dead && input.respawnSeconds !== undefined) healthText.textContent = respawnText(input.respawnSeconds)
      while (slots.length < input.abilities.length) {
        const slot: HudSlot = {
          root: document.createElement('div'),
          icons: document.createElement('span'),
          key: document.createElement('span'),
          name: document.createElement('span'),
          time: document.createElement('span'),
        }
        slot.root.className = 'hud-slot'
        slot.key.className = 'hud-slot-key'
        slot.name.className = 'hud-slot-name'
        slot.time.className = 'hud-slot-time'
        slot.icons.className = 'hud-slot-icons'
        slot.root.append(slot.icons, slot.key, slot.name, slot.time)
        abilities.append(slot.root)
        slots.push(slot)
      }
      slots.forEach((slot, index) => {
        const view = input.abilities[index]
        slot.root.hidden = view === undefined
        if (!view) return
        if (slot.iconAbilityId !== view.abilityId) {
          const grey = createAbilityIcon(view.abilityId, abilityIconUrl)
          grey.classList.add('is-grey')
          const colour = createAbilityIcon(view.abilityId, abilityIconUrl)
          colour.classList.add('is-colour')
          slot.icons.replaceChildren(grey, colour)
          slot.iconAbilityId = view.abilityId
        }
        slot.root.classList.toggle('is-ready', view.ready)
        // 0 just cast to 1 ready; the stylesheet turns it into how much of the icon is in colour.
        slot.root.style.setProperty('--filled', String(view.filled))
        slot.key.textContent = view.key
        slot.name.textContent = view.abilityId
        slot.time.textContent = view.secondsLeft
      })
    },
    destroy(): void {
      root.remove()
    },
  }
}
