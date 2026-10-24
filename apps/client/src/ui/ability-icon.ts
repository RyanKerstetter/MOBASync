// Where an ability's icon is served from, or nothing if it has none (see `ability-icon-urls.ts`).
export type AbilityIconUrl = (abilityId: string) => string | undefined

// What is shown in place of an icon that is not there.
export const MISSING_ICON_TEXT = 'N/A'
export const MISSING_ICON_TITLE = 'Icon not available'

// The picture for an ability, as an element that fills whatever box it is put in. An ability with no
// icon file, or whose file cannot be loaded, shows `MISSING_ICON_TEXT` in its place instead of a
// broken image, so a slot is never left blank without saying why.
export function createAbilityIcon(abilityId: string, iconUrl: AbilityIconUrl): HTMLElement {
  const icon = document.createElement('span')
  icon.className = 'ability-icon'
  icon.setAttribute('aria-hidden', 'true')

  const showMissing = (): void => {
    icon.classList.add('is-missing')
    icon.title = `${MISSING_ICON_TITLE}: ${abilityId}`
    icon.replaceChildren(document.createTextNode(MISSING_ICON_TEXT))
  }

  const url = iconUrl(abilityId)
  if (url === undefined) {
    showMissing()
    return icon
  }
  const image = document.createElement('img')
  image.alt = ''
  image.draggable = false
  image.addEventListener('error', showMissing, { once: true })
  image.src = url
  icon.append(image)
  return icon
}
