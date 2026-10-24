import { healthReadout, respawnText, type AbilitySlotView } from './hud.ts'

export type HudInput = {
  dead: boolean
  // The controlled champion's health. Left out, the bar keeps what it last showed.
  health?: { hp: number; maxHp: number; shield: number }
  // How long until the controlled champion is back, while it is dead.
  respawnSeconds?: number
  abilities: readonly AbilitySlotView[]
}

type HudSlot = { root: HTMLElement; fill: HTMLElement; key: HTMLElement; name: HTMLElement; time: HTMLElement }

// The bottom of the screen: the exact health with its shield, and a slot for each ability that
// fills up as its cooldown runs. Plain elements over the canvas, hidden until the first update.
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
          fill: document.createElement('div'),
          key: document.createElement('span'),
          name: document.createElement('span'),
          time: document.createElement('span'),
        }
        slot.root.className = 'hud-slot'
        slot.fill.className = 'hud-slot-fill'
        slot.key.className = 'hud-slot-key'
        slot.name.className = 'hud-slot-name'
        slot.time.className = 'hud-slot-time'
        slot.root.append(slot.fill, slot.key, slot.name, slot.time)
        abilities.append(slot.root)
        slots.push(slot)
      }
      slots.forEach((slot, index) => {
        const view = input.abilities[index]
        slot.root.hidden = view === undefined
        if (!view) return
        slot.root.classList.toggle('is-ready', view.ready)
        slot.fill.style.height = `${view.filled * 100}%`
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
