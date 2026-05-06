import {
  ActionRowBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'

function buildStaffModal(): ModalBuilder {
  return new ModalBuilder()
      .setCustomId('staff:request')
      .setTitle('Staff Request')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('category')
            .setLabel('Category (ITSRI Staff, Friend of ITSRI…)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(64)
            .setPlaceholder('ITSRI Staff')
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('department')
            .setLabel('Department (Help Desk, Sales, Leadership…)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(64)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('tier')
            .setLabel('Tier (Tier 1 / Tier 2 / Tier 3 / N/A)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(16)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('real_name')
            .setLabel('Real / preferred name')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(64)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Why are you requesting this role?')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000)
        )
      )
}

export async function showStaffRequestModal(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  await interaction.showModal(buildStaffModal())
}
