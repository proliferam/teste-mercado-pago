import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  Events,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SectionBuilder,
  ThumbnailBuilder,
  TextDisplayBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from "discord.js";
import fetch from "node-fetch";
import express from "express";
import mercadopago from "mercadopago";

const userPurchaseData = new Map();
const paymentData = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const TOKEN = process.env.DISCORD_TOKEN;
const ROBLOX_SECURITY = process.env.ROBLOSECURITY;
const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

let CSRF_TOKEN = null;

// Configurar Mercado Pago
mercadopago.configure({
  access_token: MERCADOPAGO_ACCESS_TOKEN,
});

// Servidor Express para webhooks
const app = express();
app.use(express.json());

// 30 minutos de auto-delete de thread
const THREAD_AUTO_DELETE_MS = 30 * 60 * 1000;

// ================================================================
// 🔵 FUNÇÕES DE AUTENTICAÇÃO
// ================================================================
async function getCsrfToken() {
  if (CSRF_TOKEN) return CSRF_TOKEN;

  try {
    const res = await fetch("https://auth.roblox.com/v2/logout", {
      method: "POST",
      headers: {
        Cookie: `.ROBLOSECURITY=${ROBLOX_SECURITY}`,
        "Content-Type": "application/json",
      },
    });

    const token = res.headers.get("x-csrf-token");
    if (token) {
      CSRF_TOKEN = token;
      console.log("🔑 CSRF Token obtido com sucesso.");
      return token;
    } else {
      console.error("❌ Falha ao obter CSRF Token. Cookie inválido ou bloqueado.");
      return null;
    }
  } catch (error) {
    console.error("Erro ao obter CSRF Token:", error);
    return null;
  }
}

async function buildRobloxHeaders(method = "GET") {
  const headers = {
    "Content-Type": "application/json",
    Cookie: `.ROBLOSECURITY=${ROBLOX_SECURITY}`,
  };
  const csrfToken = await getCsrfToken();
  if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken;
  return headers;
}

// ================================================================
// 🔵 FUNÇÕES ROBLOX
// ================================================================
async function getRobloxUser(username) {
  try {
    const body = { usernames: [username], excludeBannedUsers: false };
    const headers = await buildRobloxHeaders("POST");
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.data?.[0] || null;
  } catch (err) {
    console.error("Erro getRobloxUser:", err);
    return null;
  }
}

async function getRobloxAvatar(userId) {
  const fallback =
    "https://tr.rbxcdn.com/586b643537454d63e6245c5cf50a729df805a2f878ed397e9e273b0fcd57ac6b/150/150/AvatarHeadshot/Png";
  try {
    const headers = await buildRobloxHeaders("GET");
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
      { headers }
    );
    const data = await res.json();
    return data.data?.[0]?.imageUrl || fallback;
  } catch (err) {
    console.error("Erro getRobloxAvatar:", err);
    return fallback;
  }
}

async function getUserGames(userId) {
  try {
    const headers = await buildRobloxHeaders("GET");
    const res = await fetch(
      `https://games.roblox.com/v2/users/${userId}/games?accessFilter=Public&limit=10&sortOrder=Desc`,
      { headers }
    );
    const data = await res.json();
    return data.data || [];
  } catch (err) {
    console.error("Erro getUserGames:", err);
    return [];
  }
}

// ================================================================
// 🔵 PEGAR GAMEPASSES DO USUÁRIO (API NOVA)
// ================================================================
async function getUserGamepasses(userId) {
  try {
    const res = await fetch(
      `https://apis.roblox.com/game-passes/v1/users/${userId}/game-passes?count=100`
    );

    if (!res.ok) {
      const text = await res.text();
      console.error("Falha ao buscar gamepasses:", res.status, text);
      return null;
    }

    const data = await res.json();
    return data.gamePasses || [];
  } catch (err) {
    console.error("Erro ao buscar gamepasses:", err);
    return null;
  }
}

// ================================================================
// ⭐ NOVO: PEGAR PRODUCT-INFO DE UMA GAMEPASS ESPECÍFICA
// ================================================================
async function getGamepassInfo(gamePassId) {
  try {
    const res = await fetch(
      `https://apis.roblox.com/game-passes/v1/game-passes/${gamePassId}/product-info`
    );

    if (!res.ok) {
      const text = await res.text();
      console.error("Falha ao buscar product-info da gamepass:", res.status, text);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error("Erro ao buscar product-info da gamepass:", err);
    return null;
  }
}

// ================================================================
// 🔵 FUNÇÕES AUXILIARES (THREAD & CANCELAMENTO)
// ================================================================
function generateGamepassCreateLink(placeId) {
  return `https://create.roblox.com/dashboard/creations/experiences/${placeId}/passes/create`;
}

function scheduleThreadAutoDelete(userId, thread) {
  const timeout = setTimeout(async () => {
    try {
      await thread.send("⏰ Esta compra ficou inativa por muito tempo. A thread será encerrada.");
      await thread.delete().catch(() => {});
    } catch (e) {
      console.error("Erro ao deletar thread automaticamente:", e);
    } finally {
      const data = userPurchaseData.get(userId);
      if (data) {
        if (data.threadDeleteTimeout) clearTimeout(data.threadDeleteTimeout);
        userPurchaseData.delete(userId);
      }
    }
  }, THREAD_AUTO_DELETE_MS);

  const current = userPurchaseData.get(userId) || {};
  userPurchaseData.set(userId, {
    ...current,
    threadId: thread.id,
    threadDeleteTimeout: timeout,
  });
}

function clearThreadAutoDelete(userId) {
  const data = userPurchaseData.get(userId);
  if (!data) return;
  if (data.threadDeleteTimeout) {
    clearTimeout(data.threadDeleteTimeout);
    data.threadDeleteTimeout = null;
  }
  userPurchaseData.set(userId, data);
}

// ================================================================
// 🔵 FUNÇÕES MERCADO PAGO
// ================================================================
async function createMercadoPagoPayment({ userId, valorReceber, description }) {
  try {
    const preference = {
      items: [
        {
          title: `Compra de ${valorReceber} Robux`,
          description: description,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: calculatePriceInBRL(valorReceber),
        },
      ],
      back_urls: {
        success: `${BASE_URL}/success`,
        failure: `${BASE_URL}/failure`,
        pending: `${BASE_URL}/pending`,
      },
      auto_return: 'approved',
      notification_url: `${BASE_URL}/webhook`,
      metadata: {
        discord_user_id: userId,
        robux_amount: valorReceber,
        timestamp: Date.now(),
      },
    };

    const response = await mercadopago.preferences.create(preference);
    
    // Salvar dados do pagamento
    paymentData.set(response.body.id, {
      discordUserId: userId,
      robuxAmount: valorReceber,
      status: 'pending',
      created: Date.now(),
    });

    return response.body;
  } catch (error) {
    console.error('Erro ao criar pagamento Mercado Pago:', error);
    throw error;
  }
}

function calculatePriceInBRL(robuxAmount) {
  // Exemplo: R$ 1,00 para cada 100 Robux (ajuste conforme sua taxa)
  const rate = 0.01; // R$ 0,01 por Robux
  return parseFloat((robuxAmount * rate).toFixed(2));
}

// ================================================================
// 🔵 BUILDERS DE CONTAINERS / BOTÕES
// ================================================================
function buildCancelButton() {
  return new ButtonBuilder()
    .setStyle(ButtonStyle.Danger)
    .setLabel("Cancelar compra")
    .setCustomId("btn_cancelar_compra");
}

function buildCancelConfirmContainer() {
  const containerBuilder = new ContainerBuilder()
    .setAccentColor(0xff0000)
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "⚠️ **Tem certeza que deseja cancelar esta compra?**\n" +
          "Se você confirmar, esta thread será encerrada e você terá que iniciar uma nova compra se quiser continuar depois."
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Danger)
          .setLabel("Sim, quero cancelar")
          .setCustomId("btn_cancelar_confirmado"),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Secondary)
          .setLabel("Não, voltar")
          .setCustomId("btn_cancelar_voltar")
      )
    );

  return containerBuilder;
}

function buildCanceledContainer() {
  return new ContainerBuilder()
    .setAccentColor(0x808080)
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "❌ **Compra cancelada.**\n" +
          "Esta thread será encerrada em alguns segundos.\n\n" +
          "Se quiser fazer uma nova compra futuramente, basta iniciar novamente pelo canal principal."
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
}

function buildConfirmUserContainer({
  usuarioDigitado,
  robloxUserId,
  robloxUsername,
  avatarURL,
  gameName,
}) {
  const containerBuilder = new ContainerBuilder()
    .setAccentColor(15105570)
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addSectionComponents(
      new SectionBuilder()
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarURL))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "**Confirme se estas informações estão corretas antes de continuar**"
          )
        )
    )
    .addSectionComponents(
      new SectionBuilder()
        .setButtonAccessory(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("Ver perfil no Roblox")
            .setURL(`https://www.roblox.com/users/${robloxUserId}/profile`)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**Usuário digitado:** ${usuarioDigitado}\n**Usuário encontrado:** ${robloxUsername} (ID: ${robloxUserId})`
          )
        )
    );

  if (gameName) {
    containerBuilder.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**🎮 Jogo detectado:** ${gameName}`)
    );
  } else {
    containerBuilder.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**⚠️ Jogo:** Nenhum jogo público foi identificado neste perfil.`
      )
    );
  }

  containerBuilder
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Success)
          .setLabel("Sim, sou eu")
          .setCustomId("confirmar_usuario_sim"),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Danger)
          .setLabel("Não, quero alterar")
          .setCustomId("confirmar_usuario_nao"),
        buildCancelButton()
      )
    );

  return containerBuilder;
}

function buildPreGamepassContainer({ valorReceber, valorGamepass, createUrl }) {
  return new ContainerBuilder()
    .setAccentColor(15105570)
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL("https://youtu.be/B-LQU3J24pI?si=cnDg0_bTYYxirlAg")
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`Pra receber: **${valorReceber} Robux**`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`Você deve criar uma gamepass de: **${valorGamepass} Robux**`)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Criar gamepass")
          .setURL(createUrl ?? "https://create.roblox.com"),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Success)
          .setLabel("Continuar")
          .setCustomId("pre_gp_continuar")
      )
    );
}

function buildGamepassSelectionContainer({
  robloxUsername,
  avatarURL,
  gameName,
  gamepassesAVenda,
  fallbackManual,
}) {
  const select = gamepassesAVenda?.length
    ? new StringSelectMenuBuilder()
        .setCustomId("selecionar_gamepass")
        .setPlaceholder(
          "Selecione uma ou mais gamepasses que serão usadas na compra"
        )
        .setMinValues(1)
        .setMaxValues(Math.min(5, gamepassesAVenda.length))
        .addOptions(
          gamepassesAVenda.slice(0, 25).map((gp) => {
            const receber = Math.floor(gp.price * 0.7);
            return {
              label: gp.name.slice(0, 100) || "Sem nome",
              description: `Valor: ${gp.price} | Você receberá: ${receber}`,
              value: String(gp.gamePassId),
            };
          })
        )
    : null;

  const containerBuilder = new ContainerBuilder()
    .setAccentColor(15105570)
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addSectionComponents(
      new SectionBuilder()
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarURL))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**Usuário confirmado:** ${robloxUsername}${
              gamepassesAVenda?.length
                ? "\nAgora selecione a(s) gamepass(es) que você deseja usar na compra."
                : ""
            }`
          )
        )
    );

  if (gameName) {
    containerBuilder.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**🎮 Jogo detectado:** ${gameName}`)
    );
  } else {
    containerBuilder.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**⚠️ Jogo:** Nenhum jogo público foi identificado neste perfil.`
      )
    );
  }

  containerBuilder.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  if (select && !fallbackManual) {
    containerBuilder.addActionRowComponents(
      new ActionRowBuilder().addComponents(select)
    );
  }

  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Secondary)
      .setLabel("⬅ Voltar")
      .setCustomId("voltar_confirmacao_usuario"),
    buildCancelButton()
  );

  if (!fallbackManual && select) {
    rowButtons.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Success)
        .setLabel("✅ Confirmar seleção")
        .setCustomId("confirmar_gamepasses")
    );
  }

  if (fallbackManual) {
    containerBuilder.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "❌ Não foi possível listar automaticamente suas gamepasses.\nVocê pode informar a gamepass manualmente."
      )
    );
    rowButtons.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel("Enviar gamepass manualmente")
        .setCustomId("enviar_gamepass_manual")
    );
  }

  containerBuilder.addActionRowComponents(rowButtons);

  return containerBuilder;
}

function buildFinalSummaryContainer({
  usuarioDigitado,
  robloxUsername,
  gameName,
  placeId,
  selectedGamepasses,
}) {
  let totalPrice = 0;
  let totalReceber = 0;

  const linhas = selectedGamepasses.map((gp, idx) => {
    const preco = gp.price ?? gp.priceInRobux ?? 0;
    const receber = Math.floor(preco * 0.7);
    totalPrice += preco;
    totalReceber += receber;
    return `**${idx + 1}. ${gp.name}** — Valor: ${preco} | Você receberá: ${receber}`;
  });

  const containerBuilder = new ContainerBuilder()
    .setAccentColor(15105570)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**Detalhes finais da sua compra**")
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Usuário digitado:** ${usuarioDigitado}\n**Usuário confirmado:** ${robloxUsername}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(linhas.join("\n"))
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Total das gamepasses selecionadas:** ${totalPrice} Robux\n**Total estimado que você receberá:** ${totalReceber} Robux (aprox. 70%)`
      )
    );

  if (gameName) {
    containerBuilder
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Jogo selecionado:** ${gameName}`)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Place ID:** ${placeId}`)
      );
  }

  containerBuilder
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "✅ **Pronto!** Sua seleção de gamepasses foi confirmada.\nUm atendente utilizará essas informações para concluir a sua compra."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Secondary)
          .setLabel("⬅ Voltar para seleção de gamepasses")
          .setCustomId("voltar_para_selecao_gamepasses"),
        buildCancelButton()
      )
    );

  return containerBuilder;
}

function buildPaymentContainer({
  usuarioDigitado,
  robloxUsername,
  totalReceber,
  selectedGamepasses,
}) {
  const precoBRL = calculatePriceInBRL(totalReceber);
  
  const containerBuilder = new ContainerBuilder()
    .setAccentColor(0x009ee3)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**🎉 Finalização da Compra**")
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Usuário Roblox:** ${robloxUsername}\n**Valor a receber:** ${totalReceber} Robux\n**Valor a pagar:** R$ ${precoBRL.toFixed(2)}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "**Gamepasses selecionadas:**\n" +
        selectedGamepasses.map((gp, idx) => 
          `• ${gp.name} - ${gp.price} Robux`
        ).join("\n")
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "💳 **Escolha a forma de pagamento:**\nClique no botão abaixo para gerar seu link de pagamento seguro via Mercado Pago."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Success)
          .setLabel(`💳 Pagar R$ ${precoBRL.toFixed(2)}`)
          .setCustomId("btn_gerar_pagamento"),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Secondary)
          .setLabel("⬅ Voltar ao resumo")
          .setCustomId("voltar_para_resumo"),
        buildCancelButton()
      )
    );

  return containerBuilder;
}

function buildPaymentLinkContainer(paymentUrl) {
  return new ContainerBuilder()
    .setAccentColor(0x00a650)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**🔗 Link de Pagamento Gerado**")
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "✅ Seu link de pagamento foi gerado com sucesso!\n\n" +
        "**Próximos passos:**\n" +
        "1. Clique no botão abaixo para acessar a página de pagamento\n" +
        "2. Complete o pagamento usando Mercado Pago\n" +
        "3. Aguarde a confirmação automática\n" +
        "4. Seu Robux será enviado em até 5 minutos após a confirmação\n\n" +
        "⚠️ **Atenção:** Não feche esta thread até receber a confirmação!"
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("💰 Realizar Pagamento")
          .setURL(paymentUrl),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Secondary)
          .setLabel("🔄 Verificar Status")
          .setCustomId("btn_verificar_status")
      )
    );
}

function buildPaymentSuccessContainer() {
  return new ContainerBuilder()
    .setAccentColor(0x00a650)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**✅ Pagamento Confirmado!**")
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "🎉 **Seu pagamento foi aprovado!**\n\n" +
        "**Próximos passos:**\n" +
        "• Aguarde o processamento do seu Robux\n" +
        "• O valor será creditado em sua conta em até 5 minutos\n" +
        "• Um atendente entrará em contato em breve\n\n" +
        "📞 **Suporte:** Em caso de dúvidas, entre em contato com nossa equipe."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Success)
          .setLabel("✅ Finalizar Compra")
          .setCustomId("btn_finalizar_compra")
      )
    );
}

function buildManualGamepassContainer({
  robloxUsername,
  avatarURL,
  gameName,
  gamepass,
}) {
  const receber = Math.floor((gamepass.priceInRobux || 0) * 0.7);

  const containerBuilder = new ContainerBuilder()
    .setAccentColor(15105570)
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addSectionComponents(
      new SectionBuilder()
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarURL))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**Usuário confirmado:** ${robloxUsername}`
          )
        )
    );

  if (gameName) {
    containerBuilder.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**🎮 Jogo detectado:** ${gameName}`)
    );
  }

  containerBuilder
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Gamepass informada:** ${gamepass.name || "Sem nome"}\n` +
          `**ID:** ${gamepass.id}\n` +
          `**Preço:** ${
            gamepass.priceInRobux != null ? gamepass.priceInRobux : "—"
          } Robux\n` +
          `**Estimativa que você receberá:** ${
            gamepass.priceInRobux != null ? receber : "—"
          } Robux (70%)`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🔗 [Abrir gamepass no Roblox](https://www.roblox.com/game-pass/${gamepass.id}/-)`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "Se estiver tudo certo com essa gamepass, clique em **Confirmar seleção** abaixo.\n" +
          "Caso queira alterar, basta informar outra gamepass."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Secondary)
          .setLabel("⬅ Voltar para seleção de gamepasses")
          .setCustomId("voltar_para_selecao_gamepasses"),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Success)
          .setLabel("✅ Confirmar seleção")
          .setCustomId("confirmar_gamepasses"),
        buildCancelButton()
      )
    );

  return containerBuilder;
}

function buildGamepassMismatchContainer({
  robloxUsername,
  avatarURL,
  gameName,
  gamepass,
  creatorId,
  creatorName,
}) {
  const receber = Math.floor((gamepass.priceInRobux || 0) * 0.7);

  const containerBuilder = new ContainerBuilder()
    .setAccentColor(15105570)
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addSectionComponents(
      new SectionBuilder()
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarURL))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**Atenção — proprietário diferente detectado**`
          )
        )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `A gamepass informada pertence a **${creatorName}** (ID: ${creatorId}) — **não** corresponde ao usuário confirmado **${robloxUsername}**.\n\n` +
          `**Gamepass:** ${gamepass.name || "Sem nome"}\n` +
          `**ID:** ${gamepass.id}\n` +
          `**Preço:** ${
            gamepass.priceInRobux != null ? gamepass.priceInRobux : "—"
          } Robux\n` +
          `**Estimativa que você receberá:** ${
            gamepass.priceInRobux != null ? receber : "—"
          } Robux (70%)`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "Se você é realmente o dono desta gamepass, verifique o usuário que você confirmado. Se não for, cancele a operação.\n" +
          "Você pode voltar para selecionar outra gamepass ou forçar a confirmação (somente se o atendimento permitir)."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Secondary)
          .setLabel("⬅ Voltar para seleção de gamepasses")
          .setCustomId("voltar_para_selecao_gamepasses"),
        new ButtonBuilder()
          .setStyle(ButtonStyle.Danger)
          .setLabel("Forçar confirmar (prosseguir mesmo assim)")
          .setCustomId("confirmar_gamepasses_force"),
        buildCancelButton()
      )
    );

  return containerBuilder;
}

// ================================================================
// 🔵 WEBHOOK MERCADO PAGO
// ================================================================
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    
    if (type === 'payment') {
      const paymentId = data.id;
      const payment = await mercadopago.payment.findById(paymentId);
      
      if (payment.body) {
        const paymentInfo = payment.body;
        const preferenceId = paymentInfo.metadata.preference_id;
        const storedPayment = paymentData.get(preferenceId);
        
        if (storedPayment) {
          const { discordUserId, robuxAmount } = storedPayment;
          
          // Atualizar status do pagamento
          storedPayment.status = paymentInfo.status;
          storedPayment.payment_id = paymentId;
          paymentData.set(preferenceId, storedPayment);
          
          if (paymentInfo.status === 'approved') {
            // Buscar dados do usuário
            const userData = userPurchaseData.get(discordUserId);
            if (userData && userData.threadId) {
              const thread = await client.channels.fetch(userData.threadId);
              
              // Enviar mensagem de confirmação
              const successContainer = buildPaymentSuccessContainer();
              await thread.send({
                flags: MessageFlags.IsComponentsV2,
                components: [successContainer],
              });
              
              // Notificar atendentes
              await thread.send(`📢 **Pagamento Aprovado**\n<@${discordUserId}> seu pagamento de ${robuxAmount} Robux foi aprovado!`);
              
              console.log(`✅ Pagamento aprovado para usuário ${discordUserId}`);
            }
          }
        }
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(500).send('Error');
  }
});

// Rotas simples para redirecionamento
app.get('/success', (req, res) => {
  res.send('Pagamento aprovado! Volte ao Discord para continuar.');
});

app.get('/failure', (req, res) => {
  res.send('Pagamento recusado. Tente novamente no Discord.');
});

app.get('/pending', (req, res) => {
  res.send('Pagamento pendente. Aguarde a confirmação no Discord.');
});

// ================================================================
// 🔵 CLIENTE DISCORD
// ================================================================
client.once(Events.ClientReady, () => {
  console.log(`Logado como ${client.user.tag}`);
  
  // Iniciar servidor webhook
  app.listen(WEBHOOK_PORT, () => {
    console.log(`🌐 Webhook server rodando na porta ${WEBHOOK_PORT}`);
    console.log(`🔗 URL base: ${BASE_URL}`);
  });
});

client.on(Events.ClientReady, async () => {
  try {
    await client.application.commands.set([
      { name: "sendcomponents", description: "Envia o painel de compra de Robux" },
    ]);
    console.log("✅ Comandos slash registrados com sucesso!");
  } catch (error) {
    console.error("❌ Erro ao registrar comandos slash:", error);
  }
});

// ================================================================
// 🔵 SLASH COMMAND /sendcomponents
// ================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "sendcomponents") return;

  try {
    const components = [
      new ContainerBuilder()
        .setAccentColor(0xe6b422)
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder().setURL(
              "https://media.discordapp.net/attachments/1397917461336035471/1439417508955426846/INICIAR.png?format=webp"
            )
          )
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Secondary)
              .setLabel("Iniciar compra")
              .setCustomId("criar_thread_privada")
          )
        ),
    ];

    await interaction.reply({ 
      flags: MessageFlags.IsComponentsV2, 
      components,
      ephemeral: false 
    });
  } catch (error) {
    console.error("Erro ao executar comando /sendcomponents:", error);
    
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Ocorreu um erro ao processar o comando. Tente novamente.",
        ephemeral: true
      }).catch(console.error);
    }
  }
});

// ================================================================
// 🔵 BOTÕES GERAIS (thread, continuar, fechar, confirmar usuário, cancelar)
// ================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    if (interaction.customId === "criar_thread_privada") {
      const thread = await interaction.channel.threads.create({
        name: `Compra - ${interaction.user.username}`,
        type: ChannelType.PrivateThread,
        invitable: false,
      });

      await thread.members.add(interaction.user.id);
      await thread.send(
        `Olá <@${interaction.user.id}>, bem-vindo à sua compra privada!`
      );

      const msg = await thread.send({
        flags: MessageFlags.IsComponentsV2,
        components: [
          new ContainerBuilder()
            .setAccentColor(15105570)
            .addSeparatorComponents(
              new SeparatorBuilder()
                .setSpacing(SeparatorSpacingSize.Small)
                .setDivider(true)
            )
            .addMediaGalleryComponents(
              new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(
                  "https://media.discordapp.net/attachments/1397917461336035471/1439417508955426846/INICIAR.png?format=webp"
                )
              )
            )
            .addSeparatorComponents(
              new SeparatorBuilder()
                .setSpacing(SeparatorSpacingSize.Small)
                .setDivider(true)
            )
            .addActionRowComponents(
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setStyle(ButtonStyle.Link)
                  .setLabel("Calculadora de valores")
                  .setURL(
                    "https://discord.com/channels/1393579766698737786/1435746897808850974"
                  ),
                new ButtonBuilder()
                  .setStyle(ButtonStyle.Secondary)
                  .setLabel("Continuar compra")
                  .setCustomId("btn_continuar"),
                buildCancelButton()
              )
            ),
        ],
      });

      // salva dados da thread + timeout
      const current = userPurchaseData.get(interaction.user.id) || {};
      userPurchaseData.set(interaction.user.id, {
        ...current,
        lastMessageId: msg.id,
        lastChannelId: msg.channel.id,
        threadId: thread.id,
      });

      scheduleThreadAutoDelete(interaction.user.id, thread);

      // MENSAGEM EPHEMERAL COM CONTAINER V2
      await interaction.reply({
        ephemeral: true,
        flags: MessageFlags.IsComponentsV2,
        components: [
          new ContainerBuilder()
            .setAccentColor(15105570)
            .addSectionComponents(
              new SectionBuilder()
                .setButtonAccessory(
                  new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel("continuar compra")
                    .setURL(thread.url)
                )
                .addTextDisplayComponents(
                  new TextDisplayBuilder()
                    .setContent("Thread criada!")
                )
            )
        ]
      });

      return;
    }

    if (interaction.customId === "btn_fechar") {
      await interaction.reply({
        content:
          "A sua thread de compra será encerrada em instantes. Caso precise, você pode iniciar uma nova compra a qualquer momento.",
        ephemeral: true,
      });

      setTimeout(() => interaction.channel.delete().catch(() => {}), 1500);
      return;
    }

    if (interaction.customId === "btn_continuar") {
      return openPurchaseForm(interaction);
    }

    if (interaction.customId === "confirmar_usuario_nao") {
      return openPurchaseForm(interaction);
    }

    if (interaction.customId === "confirmar_usuario_sim") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data) {
        return interaction.reply({
          content: "❌ Não encontrei os dados da sua sessão de compra. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      // 🔵 PASSO 3: MOSTRAR PRÉ-TELA DA GAMEPASS
      const preContainer = buildPreGamepassContainer({
        valorReceber: data.valorDesejado,
        valorGamepass: data.valorGamepass,
        createUrl: data.gamepassCreateUrl
      });

      data.lastContainer = preContainer;
      userPurchaseData.set(interaction.user.id, data);

      const { lastMessageId, lastChannelId } = data;

      try {
        const channel = await client.channels.fetch(lastChannelId);
        const message = await channel.messages.fetch(lastMessageId);

        await message.edit({
          flags: MessageFlags.IsComponentsV2,
          components: [preContainer],
        });

        return interaction.deferUpdate();
      } catch (e) {
        console.error("Erro ao mostrar pré-tela:", e);
      }
    }

    if (interaction.customId === "pre_gp_continuar") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data) {
        return interaction.reply({
          content: "❌ Erro interno. Reinicie a compra.",
          ephemeral: true,
        });
      }

      // CONTINUA COM O PROCESSO ORIGINAL DE DETECÇÃO DE GAMEPASSES
      const {
        robloxUserId,
        gameName,
        avatarURL,
        robloxUsername,
        lastMessageId,
        lastChannelId,
      } = data;

      const gamepasses = await getUserGamepasses(robloxUserId);

      let gamepassesAVenda = [];
      let fallbackManual = false;

      if (gamepasses === null) {
        fallbackManual = true;
      } else {
        gamepassesAVenda = gamepasses.filter((gp) => gp.isForSale);
        if (!gamepassesAVenda.length) {
          fallbackManual = true;
        }
      }

      data.gamepassesAVenda = gamepassesAVenda;
      const containerBuilder = buildGamepassSelectionContainer({
        robloxUsername,
        avatarURL,
        gameName,
        gamepassesAVenda,
        fallbackManual,
      });

      data.lastSelectionContainer = containerBuilder;
      data.lastContainer = containerBuilder;
      userPurchaseData.set(interaction.user.id, data);

      try {
        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
          });
          await interaction.deferUpdate();
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }
      } catch (e) {
        console.error("Erro ao atualizar para seleção de gamepasses:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "Ocorreu um erro ao atualizar a mensagem. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }

    if (interaction.customId === "voltar_confirmacao_usuario") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data) {
        return interaction.reply({
          content:
            "❌ Não encontrei os dados da sua sessão de compra. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      const {
        usuarioDigitado,
        robloxUserId,
        robloxUsername,
        avatarURL,
        gameName,
        lastMessageId,
        lastChannelId,
      } = data;

      const containerBuilder = buildConfirmUserContainer({
        usuarioDigitado,
        robloxUserId,
        robloxUsername,
        avatarURL,
        gameName,
      });

      data.lastContainer = containerBuilder;
      userPurchaseData.set(interaction.user.id, data);

      try {
        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
          });
          await interaction.deferUpdate();
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }
      } catch (e) {
        console.error("Erro ao voltar para confirmação de usuário:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "Ocorreu um erro ao atualizar a mensagem. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }

    if (interaction.customId === "voltar_para_selecao_gamepasses") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data || !data.lastSelectionContainer) {
        return interaction.reply({
          content:
            "❌ Não encontrei os dados da sua seleção de gamepasses. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      const { lastMessageId, lastChannelId, lastSelectionContainer } = data;

      data.lastContainer = lastSelectionContainer;
      userPurchaseData.set(interaction.user.id, data);

      try {
        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [lastSelectionContainer],
          });
          await interaction.deferUpdate();
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [lastSelectionContainer],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }
      } catch (e) {
        console.error("Erro ao voltar para seleção de gamepasses:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "Ocorreu um erro ao atualizar a mensagem. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }

    if (interaction.customId === "enviar_gamepass_manual") {
      const modal = new ModalBuilder()
        .setCustomId("modal_gamepass_manual")
        .setTitle("Informar gamepass manualmente");

      const input = new TextInputBuilder()
        .setCustomId("gamepassManual")
        .setLabel("Link ou ID da gamepass")
        .setPlaceholder(
          "Ex: https://www.roblox.com/game-pass/123456/MeuPass ou 123456"
        )
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

      modal.addComponents(new ActionRowBuilder().addComponents(input));

      await interaction.showModal(modal);
      return;
    }

    // ========== PAGAMENTO ==========
    if (interaction.customId === "btn_gerar_pagamento") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data) {
        return interaction.reply({
          content: "❌ Não encontrei os dados da sua compra. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      const { robloxUsername, selectedGamepasses } = data;
      
      // Calcular total a receber
      let totalReceber = 0;
      selectedGamepasses.forEach(gp => {
        totalReceber += Math.floor((gp.price ?? gp.priceInRobux ?? 0) * 0.7);
      });

      try {
        // Criar pagamento no Mercado Pago
        const payment = await createMercadoPagoPayment({
          userId: interaction.user.id,
          valorReceber: totalReceber,
          description: `Compra de ${totalReceber} Robux para ${robloxUsername}`
        });

        // Atualizar dados do usuário
        data.paymentId = payment.id;
        userPurchaseData.set(interaction.user.id, data);

        // Mostrar link de pagamento
        const paymentContainer = buildPaymentLinkContainer(payment.init_point);
        
        if (data.lastMessageId && data.lastChannelId) {
          const channel = await client.channels.fetch(data.lastChannelId);
          const message = await channel.messages.fetch(data.lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [paymentContainer],
          });
          await interaction.deferUpdate();
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [paymentContainer],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }

      } catch (error) {
        console.error('Erro ao gerar pagamento:', error);
        await interaction.reply({
          content: "❌ Erro ao gerar link de pagamento. Tente novamente.",
          ephemeral: true,
        });
      }
      return;
    }

    if (interaction.customId === "voltar_para_resumo") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data) {
        return interaction.reply({
          content: "❌ Não encontrei os dados da sua compra. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      const {
        usuarioDigitado,
        robloxUsername,
        gameName,
        placeId,
        selectedGamepasses,
        lastMessageId,
        lastChannelId,
      } = data;

      const containerBuilder = buildFinalSummaryContainer({
        usuarioDigitado,
        robloxUsername,
        gameName,
        placeId,
        selectedGamepasses,
      });

      data.lastContainer = containerBuilder;
      userPurchaseData.set(interaction.user.id, data);

      try {
        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
          });
          await interaction.deferUpdate();
        }
      } catch (e) {
        console.error("Erro ao voltar para resumo:", e);
      }
      return;
    }

    // ========== CANCELAMENTO (CONFIRM / VOLTAR / CONFIRMADO) ==========
    if (interaction.customId === "btn_cancelar_compra") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data) {
        return interaction.reply({
          content:
            "❌ Não encontrei os dados da sua sessão de compra. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      // mostra container de CONFIRMAÇÃO de cancelamento
      const container = buildCancelConfirmContainer();

      try {
        if (data.lastMessageId && data.lastChannelId) {
          const channel = await client.channels.fetch(data.lastChannelId);
          const message = await channel.messages.fetch(data.lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [container],
          });

          // não mandar mensagem extra após isso
          await interaction.deferUpdate();
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [container],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }
      } catch (e) {
        console.error("Erro ao exibir confirmação de cancelamento:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content:
              "⚠️ Não foi possível exibir a tela de confirmação de cancelamento. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }

    if (interaction.customId === "btn_cancelar_voltar") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data || !data.lastContainer) {
        return interaction.reply({
          content:
            "❌ Não encontrei o estado anterior da sua compra. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      const { lastMessageId, lastChannelId, lastContainer } = data;

      try {
        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [lastContainer],
          });
          await interaction.deferUpdate();
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [lastContainer],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }
      } catch (e) {
        console.error("Erro ao voltar do cancelamento:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content:
              "⚠️ Não foi possível restaurar o estado anterior. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }

    if (interaction.customId === "btn_cancelar_confirmado") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data) {
        return interaction.reply({
          content:
            "❌ Não encontrei os dados da sua sessão de compra. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      const { lastMessageId, lastChannelId, threadId } = data;
      const container = buildCanceledContainer();

      try {
        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);

          // edita a mensagem principal com container de CANCELADO
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [container],
          });

          // NÃO envia mensagem adicional na thread
          await interaction.deferUpdate();
        } else {
          await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [container],
          });
        }

        // cancela auto-delete anterior
        clearThreadAutoDelete(interaction.user.id);

        // agenda deletar a thread em 10 segundos
        if (threadId) {
          const threadChannel = await client.channels.fetch(threadId).catch(() => null);
          if (threadChannel) {
            setTimeout(async () => {
              try {
                await threadChannel.delete().catch(() => {});
              } catch (e) {
                console.error("Erro ao deletar thread após cancelamento:", e);
              }
            }, 10 * 1000);
          }
        }

        // limpa estado
        userPurchaseData.delete(interaction.user.id);
      } catch (e) {
        console.error("Erro ao confirmar cancelamento:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "⚠️ Ocorreu um erro ao cancelar a compra. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }

    if (interaction.customId === "confirmar_gamepasses_force") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data || !data.selectedGamepasses || !data.selectedGamepasses.length) {
        return interaction.reply({
          content:
            "❌ Não há uma gamepass selecionada para forçar confirmação. Informe a gamepass manualmente antes.",
          ephemeral: true,
        });
      }

      const {
        usuarioDigitado,
        robloxUsername,
        gameName,
        placeId,
        selectedGamepasses,
        lastMessageId,
        lastChannelId,
      } = data;

      const containerBuilder = buildFinalSummaryContainer({
        usuarioDigitado,
        robloxUsername,
        gameName,
        placeId,
        selectedGamepasses,
      });

      data.lastContainer = containerBuilder;
      userPurchaseData.set(interaction.user.id, data);

      try {
        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
          });
          await interaction.deferUpdate();
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }
      } catch (e) {
        console.error("Erro forçar confirmar:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "Erro ao tentar confirmar. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }

    if (interaction.customId === "confirmar_gamepasses") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data || !data.selectedGamepasses || !data.selectedGamepasses.length) {
        return interaction.reply({
          content:
            "⚠️ Você ainda não selecionou nenhuma gamepass ou houve um erro ao recuperar sua seleção. Selecione novamente as gamepasses.",
          ephemeral: true,
        });
      }

      const {
        usuarioDigitado,
        robloxUsername,
        gameName,
        placeId,
        selectedGamepasses,
        lastMessageId,
        lastChannelId,
      } = data;

      // Calcular total a receber
      let totalReceber = 0;
      selectedGamepasses.forEach(gp => {
        totalReceber += Math.floor((gp.price ?? gp.priceInRobux ?? 0) * 0.7);
      });

      // Mostrar tela de pagamento em vez do resumo final
      const paymentContainer = buildPaymentContainer({
        usuarioDigitado,
        robloxUsername,
        totalReceber,
        selectedGamepasses,
      });

      data.lastContainer = paymentContainer;
      userPurchaseData.set(interaction.user.id, data);

      try {
        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [paymentContainer],
          });
          await interaction.deferUpdate();
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [paymentContainer],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }
      } catch (e) {
        console.error("Erro ao confirmar gamepasses:", e);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "Erro ao tentar confirmar. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }

  } catch (error) {
    console.error(`Erro no handler de botão ${interaction.customId}:`, error);
    
    // Tenta responder com erro se a interação ainda for válida
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Ocorreu um erro ao processar sua ação. Tente novamente.",
        ephemeral: true
      }).catch(console.error);
    }
  }
});

// ================================================================
// 🔵 MODAL: PEDE APENAS O USUÁRIO ROBLOX
// ================================================================
async function openPurchaseForm(interaction) {
  try {
    const modal = new ModalBuilder()
      .setCustomId("modal_compra")
      .setTitle("Informações da compra");

    const robloxUser = new TextInputBuilder()
      .setCustomId("robloxUser")
      .setLabel("Seu usuário Roblox")
      .setPlaceholder("Ex: proliferam")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);

    const valorInput = new TextInputBuilder()
      .setCustomId("valorDesejado")
      .setLabel("Quanto você quer receber? (ex: 1000)")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);

    modal.addComponents(
      new ActionRowBuilder().addComponents(robloxUser),
      new ActionRowBuilder().addComponents(valorInput)
    );

    await interaction.showModal(modal);
  } catch (error) {
    console.error("Erro ao abrir modal:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Erro ao abrir o formulário. Tente novamente.",
        ephemeral: true
      }).catch(console.error);
    }
  }
}

// ================================================================
// 🔵 SUBMIT DO MODAL: BUSCA USUÁRIO E MOSTRA CONFIRMAÇÃO
// ================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  try {
    // MODAL COMPRA
    if (interaction.customId === "modal_compra") {
      const usuario = interaction.fields.getTextInputValue("robloxUser");
      
      const valor = parseInt(interaction.fields.getTextInputValue("valorDesejado"));
      if (isNaN(valor) || valor <= 0) {
        return interaction.reply({
          content: "❌ O valor digitado é inválido. Use apenas números.",
          ephemeral: true,
        });
      }

      // 🔵 CORREÇÃO: Cálculo correto para gamepass de 1429 Robux para receber 1000
      const valorGamepass = Math.ceil(valor / 0.7);

      const robloxUser = await getRobloxUser(usuario);
      if (!robloxUser)
        return interaction.reply({
          content:
            "❌ Não encontrei nenhum usuário com esse nome no Roblox. Verifique se digitou corretamente e tente novamente.",
          ephemeral: true,
        });

      const userGames = await getUserGames(robloxUser.id);

      let placeId = null;
      let gameName = null;
      let gamepassCreateUrl = null;

      if (userGames.length > 0) {
        const recentGame = userGames[0];

        placeId = recentGame.id || recentGame.placeId || null;
        gameName = recentGame.name || null;

        if (placeId) {
          gamepassCreateUrl = generateGamepassCreateLink(placeId);
        }

        console.log(`Jogo encontrado: ${gameName} (Place ID: ${placeId})`);
        console.log(`Link de CRIAÇÃO gerado: ${gamepassCreateUrl}`);
      } else {
        console.log("Nenhum jogo encontrado para o usuário");
      }

      const avatarURL = await getRobloxAvatar(robloxUser.id);

      const previous = userPurchaseData.get(interaction.user.id) || {};
      userPurchaseData.set(interaction.user.id, {
        ...previous,
        usuarioDigitado: usuario,
        robloxUserId: robloxUser.id,
        robloxUsername: robloxUser.name,
        avatarURL,
        gameName,
        placeId,
        gamepassCreateUrl,
        valorDesejado: valor,
        valorGamepass: valorGamepass,
        selectedGamepasses: [],
        lastChannelId: interaction.channelId,
      });

      const containerBuilder = buildConfirmUserContainer({
        usuarioDigitado: usuario,
        robloxUserId: robloxUser.id,
        robloxUsername: robloxUser.name,
        avatarURL,
        gameName,
      });

      const saved = userPurchaseData.get(interaction.user.id);
      if (saved?.lastMessageId && saved?.lastChannelId) {
        try {
          const channel = await client.channels.fetch(saved.lastChannelId);
          const message = await channel.messages.fetch(saved.lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
          });

          saved.lastContainer = containerBuilder;
          userPurchaseData.set(interaction.user.id, saved);

          await interaction.deferUpdate();

          return;
        } catch (e) {
          console.error("Erro ao editar mensagem existente no modal_compra:", e);
        }
      }

      const reply = await interaction.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [containerBuilder],
        fetchReply: true,
      });

      const saved2 = userPurchaseData.get(interaction.user.id);
      if (saved2) {
        saved2.lastMessageId = reply.id;
        saved2.lastChannelId = reply.channel.id;
        saved2.lastContainer = containerBuilder;
        userPurchaseData.set(interaction.user.id, saved2);
      }
      return;
    }

    // MODAL GAMEPASS MANUAL
    if (interaction.customId === "modal_gamepass_manual") {
      const data = userPurchaseData.get(interaction.user.id);
      if (!data) {
        return interaction.reply({
          content:
            "❌ Não encontrei os dados da sua sessão de compra. Por favor, inicie novamente.",
          ephemeral: true,
        });
      }

      const raw = interaction.fields.getTextInputValue("gamepassManual").trim();

      let idMatch = raw.match(/(\d+)/);
      if (!idMatch) {
        return interaction.reply({
          content:
            "❌ Não consegui identificar um ID de gamepass válido. Envie apenas o ID ou o link da gamepass.",
          ephemeral: true,
        });
      }

      const gamePassId = idMatch[1];

      const info = await getGamepassInfo(gamePassId);
      if (!info) {
        return interaction.reply({
          content:
            "❌ Não consegui obter informações dessa gamepass na API. Verifique se o ID está correto ou se a gamepass é pública.",
          ephemeral: true,
        });
      }

      const manualGp = {
        gamePassId: gamePassId,
        name: info.Name || `Gamepass ${gamePassId}`,
        price: info.PriceInRobux ?? 0,
        priceInRobux: info.PriceInRobux ?? 0,
        manual: true,
        rawInfo: info,
      };

      const creator = info.Creator || null;
      const creatorId = creator?.Id ?? null;
      const creatorName = creator?.Name ?? null;

      data.selectedGamepasses = [];
      userPurchaseData.set(interaction.user.id, data);

      const {
        robloxUsername,
        avatarURL,
        gameName,
        lastMessageId,
        lastChannelId,
        robloxUserId,
      } = data;

      try {
        if (creatorId && String(creatorId) === String(robloxUserId)) {
          data.selectedGamepasses = [manualGp];
          userPurchaseData.set(interaction.user.id, data);

          const containerBuilder = buildManualGamepassContainer({
            robloxUsername,
            avatarURL,
            gameName,
            gamepass: {
              id: gamePassId,
              name: info.Name,
              priceInRobux: info.PriceInRobux,
            },
          });

          data.lastContainer = containerBuilder;
          userPurchaseData.set(interaction.user.id, data);

          if (lastMessageId && lastChannelId) {
            const channel = await client.channels.fetch(lastChannelId);
            const message = await channel.messages.fetch(lastMessageId);
            await message.edit({
              flags: MessageFlags.IsComponentsV2,
              components: [containerBuilder],
            });
            await interaction.reply({
              content: "Gamepass carregada com sucesso e vinculada à sua conta.",
              ephemeral: true,
            });
          } else {
            const reply = await interaction.reply({
              flags: MessageFlags.IsComponentsV2,
              components: [containerBuilder],
              fetchReply: true,
            });
            data.lastMessageId = reply.id;
            data.lastChannelId = reply.channel.id;
            userPurchaseData.set(interaction.user.id, data);
          }
          return;
        }

        if (creatorId && String(creatorId) !== String(robloxUserId)) {
          data.selectedGamepasses = [manualGp];

          data.foundManualGamepass = {
            id: gamePassId,
            name: info.Name,
            priceInRobux: info.PriceInRobux,
            creatorId,
            creatorName,
            rawInfo: info,
          };

          const containerBuilder = buildGamepassMismatchContainer({
            robloxUsername,
            avatarURL,
            gameName,
            gamepass: {
              id: gamePassId,
              name: info.Name,
              priceInRobux: info.PriceInRobux,
            },
            creatorId,
            creatorName,
          });

          data.lastContainer = containerBuilder;
          userPurchaseData.set(interaction.user.id, data);

          if (lastMessageId && lastChannelId) {
            const channel = await client.channels.fetch(lastChannelId);
            const message = await channel.messages.fetch(lastMessageId);
            await message.edit({
              flags: MessageFlags.IsComponentsV2,
              components: [containerBuilder],
            });

            if (!interaction.deferred && !interaction.replied) {
              await interaction.deferUpdate();
            }
          } else {
            const reply = await interaction.reply({
              flags: MessageFlags.IsComponentsV2,
              components: [containerBuilder],
              fetchReply: true,
            });
            data.lastMessageId = reply.id;
            data.lastChannelId = reply.channel.id;
            userPurchaseData.set(interaction.user.id, data);
          }
          return;
        }

        data.selectedGamepasses = [manualGp];
        userPurchaseData.set(interaction.user.id, data);

        const containerBuilder = buildManualGamepassContainer({
          robloxUsername,
          avatarURL,
          gameName,
          gamepass: {
            id: gamePassId,
            name: info.Name,
            priceInRobux: info.PriceInRobux,
          },
        });

        data.lastContainer = containerBuilder;
        userPurchaseData.set(interaction.user.id, data);

        if (lastMessageId && lastChannelId) {
          const channel = await client.channels.fetch(lastChannelId);
          const message = await channel.messages.fetch(lastMessageId);
          await message.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
          });
          await interaction.reply({
            content: "Gamepass carregada com sucesso.",
            ephemeral: true,
          });
        } else {
          const reply = await interaction.reply({
            flags: MessageFlags.IsComponentsV2,
            components: [containerBuilder],
            fetchReply: true,
          });
          data.lastMessageId = reply.id;
          data.lastChannelId = reply.channel.id;
          userPurchaseData.set(interaction.user.id, data);
        }
      } catch (e) {
        console.error("Erro ao atualizar mensagem da gamepass manual:", e);
        if (!interaction.replied && !interaction.deferred) {
          return interaction.reply({
            content:
              "⚠️ A gamepass foi encontrada, mas ocorreu um erro ao atualizar a mensagem principal. Avise um atendente.",
            ephemeral: true,
          });
        }
      }

      return;
    }
  } catch (error) {
    console.error("Erro no handler de modal:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Ocorreu um erro ao processar o formulário. Tente novamente.",
        ephemeral: true
      }).catch(console.error);
    }
  }
});

// ================================================================
// 🔵 INTERAÇÃO DO SELECT: USUÁRIO ESCOLHE UMA OU MAIS GAMEPASSES
// ================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== "selecionar_gamepass") return;

  try {
    const data = userPurchaseData.get(interaction.user.id);
    if (!data) {
      return interaction.reply({
        content:
          "❌ Não encontrei os dados da sua sessão de compra. Por favor, inicie novamente.",
        ephemeral: true,
      });
    }

    if (!interaction.values || !interaction.values.length) {
      return interaction.reply({
        content:
          "⚠️ Você não selecionou nenhuma gamepass. Selecione pelo menos uma e tente novamente.",
        ephemeral: true,
      });
    }

    const { gamepassesAVenda } = data;
    if (!gamepassesAVenda || !gamepassesAVenda.length) {
      return interaction.reply({
        content:
          "❌ Não há gamepasses carregadas para esta conta. Tente novamente ou informe manualmente.",
        ephemeral: true,
      });
    }

    const selecionadas = [];

    for (const value of interaction.values) {
      const found = gamepassesAVenda.find(
        (gp) => String(gp.gamePassId) === String(value)
      );
      if (found) {
        selecionadas.push({
          gamePassId: found.gamePassId,
          name: found.name,
          price: found.price,
        });
      }
    }

    if (!selecionadas.length) {
      return interaction.reply({
        content:
          "❌ Ocorreu um erro ao processar as gamepasses selecionadas. Tente novamente.",
        ephemeral: true,
      });
    }

    data.selectedGamepasses = selecionadas;
    userPurchaseData.set(interaction.user.id, data);

    await interaction.deferUpdate();
  } catch (error) {
    console.error("Erro no handler de select menu:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Ocorreu um erro ao processar sua seleção. Tente novamente.",
        ephemeral: true
      }).catch(console.error);
    }
  }
});

// ================================================================
// 🔵 LOGIN
// ================================================================
client.login(TOKEN).catch(console.error);