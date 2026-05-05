import { SeparatorBuilder, SeparatorSpacingSize } from 'discord.js'

/**
 * Standard small-spacing divider used in Components V2 containers across
 * panels, embeds, and command responses.
 */
export function sep() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
}
