const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  ChannelType,
  SlashCommandBuilder,
  Routes,
  MessageFlags,
} = require("discord.js");
const { REST } = require("@discordjs/rest");
const { token, clientId, guildId } = require("./config.json");
const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./database.sqlite");
db.configure("busyTimeout", 3000);

// DB 초기화 (경제/포인트 완전 삭제, 티어 및 임시 채널 관리, 참여도 컬럼 추가)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS players (
    discord_id TEXT PRIMARY KEY,
    nickname TEXT,
    tier TEXT DEFAULT '미분류',
    sub_tier TEXT DEFAULT '중',
    participation_count INTEGER DEFAULT 0
  )`);
  
  // 기존 DB 파일이 있을 경우 컬럼 강제 추가 (오류 방지)
  db.run(`ALTER TABLE players ADD COLUMN tier TEXT DEFAULT '미분류'`, (err) => {});
  db.run(`ALTER TABLE players ADD COLUMN sub_tier TEXT DEFAULT '중'`, (err) => {});
  db.run(`ALTER TABLE players ADD COLUMN participation_count INTEGER DEFAULT 0`, (err) => {});

  db.run(`CREATE TABLE IF NOT EXISTS live_votes (
    message_id TEXT,
    user_id TEXT,
    user_name TEXT,
    vote_type TEXT,
    PRIMARY KEY (message_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tier_board_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    message_id TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS participation_board_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    message_id TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS temp_channels (
    channel_id TEXT PRIMARY KEY,
    expire_at DATETIME
  )`);
});

const MANAGER_ROLE_NAME = "관리자";
const GAMER_ROLE_NAME = "서든러";
const NEW_ROLE_NAME = "new";
const UNAUTH_ROLE_NAME = "미인증 인원";
const TALK_CATEGORY_NAME = "대화방";
const VOTE_CHANNEL_NAME = "📘내전／신청";
const LOG_CHANNEL_NAME = "로그채널";
const AUTH_LOG_CHANNEL_NAME = "봇_명령어통";
const FEEDBACK_CHANNEL_NAME = "≪수신함≫";

const EMOJI_S = "🇸";
const EMOJI_R = "🇷";
const EMOJI_M = "🇲";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

process.on('uncaughtException', error => console.error('Uncaught Exception:', error));
process.on('unhandledRejection', error => console.error('Unhandled Rejection:', error));

function isVoteManager(member) { return member.roles.cache.some(r => r.name === MANAGER_ROLE_NAME) || member.guild.ownerId === member.id; }
function getKoreanDate() {
  const now = new Date();
  const kst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  return `${kst.getMonth() + 1}월 ${kst.getDate()}일 저녁 9시`;
}

// 📌 실시간 티어판 갱신 함수
async function updateTierBoard(client) {
  db.get(`SELECT guild_id, channel_id, message_id FROM tier_board_config LIMIT 1`, async (err, row) => {
    if (err || !row) return;
    try {
      const guild = await client.guilds.fetch(row.guild_id).catch(()=>null);
      if (!guild) return;
      const channel = await guild.channels.fetch(row.channel_id).catch(()=>null);
      if (!channel) return;
      const msg = await channel.messages.fetch(row.message_id).catch(()=>null);
      if (!msg) return;

      db.all(`SELECT discord_id, nickname, tier, sub_tier FROM players`, async (err, players) => {
        if (err) return;
        
        await guild.members.fetch().catch(() => {}); 
        
        let validPlayers = [];
        for (const p of players) {
            const member = guild.members.cache.get(p.discord_id) || await guild.members.fetch(p.discord_id).catch(() => null);
            
            if (member) {
                p.nickname = member.displayName;
                validPlayers.push(p);
            } else {
                // 💡 폭탄 제거: 서버 렉 때문에 멤버 정보를 못 불러왔다고 해서 DB를 날려버리는 것을 막습니다. 
                // 유저가 진짜 퇴장할 때 삭제하는 기능은 맨 아래 '퇴장 이벤트'가 안전하게 알아서 처리해 줍니다.
            }
        }
        
        const tiers = ["1티어", "1.5티어", "2티어", "2.5티어", "3티어", "3.5티어", "4티어", "4.5티어", "5티어", "새싹티어", "미분류"];
        const cls = {}; 
        
        tiers.forEach(t => cls[t] = { '상': [], '중': [], '하': [] });
        
        validPlayers.forEach(p => { 
            if (cls[p.tier]) {
                let displayName = p.nickname;
                let sub = p.sub_tier || '중';
                
                if (sub === '상') displayName += '(⬆️)';
                else if (sub === '하') displayName += '(⬇️)';
                
                cls[p.tier][sub].push(displayName);
            } 
        });

        let desc = "";
        tiers.forEach(t => { 
            const top = cls[t]['상'];
            const mid = cls[t]['중'];
            const bot = cls[t]['하'];
            
            if (top.length > 0 || mid.length > 0 || bot.length > 0) {
                desc += `**[${t}]**\n`;
                if (top.length > 0) desc += top.join(", ") + "\n";
                if (mid.length > 0) desc += mid.join(", ") + "\n";
                if (bot.length > 0) desc += bot.join(", ") + "\n";
                desc += "\n";
            }
        });

        const embed = new EmbedBuilder()
            .setTitle("🏆 Psycho 클랜 실시간 티어 현황")
            .setDescription(desc || "등록된 인원이 없습니다.")
            .setColor(0x3498db)
            .setTimestamp();

        msg.edit({ embeds: [embed] }).catch(()=>{});
      });
    } catch (e) { console.error("티어판 갱신 에러:", e); }
  });
}

// 📌 실시간 참여도판 갱신 함수 (위치 독립시킴)
async function updateParticipationBoard(client) {
  db.get(`SELECT guild_id, channel_id, message_id FROM participation_board_config LIMIT 1`, async (err, row) => {
    if (err || !row) return;
    try {
      const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
      if (!guild) return;
      const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
      if (!channel) return;
      const msg = await channel.messages.fetch(row.message_id).catch(() => null);
      if (!msg) return;

      db.all(`SELECT nickname, tier, sub_tier, participation_count FROM players`, async (err, rows) => {
        if (err) return;
        
        // 닉네임에 '/'가 있는 본계정만 필터링 및 랭킹 정렬
        const mainPlayers = rows.filter(p => p.nickname && p.nickname.includes('/'));
        mainPlayers.sort((a, b) => b.participation_count - a.participation_count || a.nickname.localeCompare(b.nickname));
        
        let desc = "";
        if (mainPlayers.length === 0) {
          desc = "등록된 본계정(`닉네임/생년`) 데이터가 없습니다.";
        } else {
          mainPlayers.forEach((p, index) => {
            let sub = p.sub_tier || '중';
            let subMark = (sub === '상') ? '(⬆️)' : (sub === '하') ? '(⬇️)' : '';
            desc += `**${index + 1}위.** ${p.nickname} [${p.tier}${subMark}] - **${p.participation_count}회**\n`;
          });
        }
        
        const embed = new EmbedBuilder()
          .setTitle("📊 월간 내전 참여도 현황 (실시간)")
          .setDescription(desc)
          .setColor(0xE67E22)
          .setFooter({ text: "닉네임에 '/'가 포함된 본계정 대상 (0회 참여자 포함)" })
          .setTimestamp();
          
        msg.edit({ embeds: [embed] }).catch(() => {});
      });
    } catch (e) { console.error("참여도판 갱신 에러:", e); }
  });
}

// 실시간 투표판 임베드 갱신
async function updateVoteEmbed(message) {
  db.all(`SELECT user_name, vote_type FROM live_votes WHERE message_id = ?`, [message.id], async (err, rows) => {
    if (err) return;
    const sNames = rows.filter(r => r.vote_type === 's').map(r => r.user_name);
    const rNames = rows.filter(r => r.vote_type === 'r').map(r => r.user_name);
    const mNames = rows.filter(r => r.vote_type === 'm').map(r => r.user_name);

    const embed = EmbedBuilder.from(message.embeds[0]);
    embed.setFields(
      { name: `${EMOJI_S} 스나이퍼 (${sNames.length}명)`, value: sNames.join(", ") || "없음" },
      { name: `${EMOJI_R} 라이플 (${rNames.length}명)`, value: rNames.join(", ") || "없음" },
      { name: `${EMOJI_M} 멀티수 (${mNames.length}명)`, value: mNames.join(", ") || "없음" }
    );
    embed.setFooter({ text: `📊 [투표 인원] 총 ${rows.length}명 참여 중` });

    await message.edit({ embeds: [embed] }).catch(()=>{});
  });
}

// 투표 종료 시 DB에서 명단과 티어를 매칭하여 정렬해 주는 함수
function formatByTierDB(names, playersList) {
  const tiers = ["1티어", "1.5티어", "2티어", "2.5티어", "3티어", "3.5티어", "4티어", "4.5티어", "5티어", "새싹티어", "미분류"];
  const cls = {}; 
  
  tiers.forEach(t => cls[t] = { '상': [], '중': [], '하': [] });
  
  names.forEach(n => {
    const p = playersList.find(pl => pl.nickname === n);
    const t = p ? p.tier : "미분류";
    
    if (cls[t]) {
        let displayName = n;
        let sub = (p && p.sub_tier) ? p.sub_tier : '중';
        
        if (sub === '상') displayName += '(⬆️)';
        else if (sub === '하') displayName += '(⬇️)';
        
        cls[t][sub].push(displayName);
    }
  });
  
  let out = "";
  tiers.forEach(t => { 
      const top = cls[t]['상'];
      const mid = cls[t]['중'];
      const bot = cls[t]['하'];
      
      if (top.length > 0 || mid.length > 0 || bot.length > 0) {
          out += `**[${t}]**\n`;
          if (top.length > 0) out += top.join(", ") + "\n";
          if (mid.length > 0) out += mid.join(", ") + "\n";
          if (bot.length > 0) out += bot.join(", ") + "\n";
          out += "\n";
      }
  });
  return out || "없음";
}

// 📌 48시간 경과 채널 자동 폭파 타이머
async function checkTempChannels() {
  const now = new Date();
  db.all(`SELECT * FROM temp_channels`, [], async (err, rows) => {
    if (err || !rows) return;
    for (const row of rows) {
      if (new Date(row.expire_at) <= now) {
        const channel = client.channels.cache.get(row.channel_id) || await client.channels.fetch(row.channel_id).catch(()=>null);
        if (channel) await channel.delete().catch(()=>{});
        db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [row.channel_id]);
      }
    }
  });
}

client.once(Events.ClientReady, async () => {
  const commands = [
    new SlashCommandBuilder().setName("투표").setDescription("대내전 투표 생성 (관리자 전용)"),
    new SlashCommandBuilder().setName("대화").setDescription("서든러 1:1 대화방 생성").addUserOption(o => o.setName("상대").setRequired(true).setDescription("상대방")),
    new SlashCommandBuilder().setName("방생성설정").setDescription("음성 채널 버튼 설정 (관리자 전용)"),
    new SlashCommandBuilder().setName("인증설정").setDescription("인증 신청 버튼 생성 (관리자 전용)"),
    new SlashCommandBuilder().setName("청소").setDescription("채널의 메시지를 삭제 (관리자 전용)").addIntegerOption(o => o.setName("개수").setDescription("삭제할 개수").setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName("룰렛").setDescription("5개의 맵 무작위 추첨"),
    
    new SlashCommandBuilder().setName("건의설정").setDescription("건의 버튼 생성 (관리자 전용)"),
    new SlashCommandBuilder().setName("티어판설정").setDescription("실시간 티어 현황판을 채널에 고정합니다 (관리자 전용)"),
    new SlashCommandBuilder().setName("티어설정").setDescription("클랜원의 티어를 설정/수정합니다 (관리자 전용)")
      .addUserOption(o => o.setName("유저").setDescription("대상을 선택하세요").setRequired(true))
      .addStringOption(o => o.setName("티어").setDescription("티어를 선택하세요").setRequired(true).addChoices(
          { name: "1티어", value: "1티어" }, { name: "1.5티어", value: "1.5티어" },
          { name: "2티어", value: "2티어" }, { name: "2.5티어", value: "2.5티어" },
          { name: "3티어", value: "3티어" }, { name: "3.5티어", value: "3.5티어" },
          { name: "4티어", value: "4티어" }, { name: "4.5티어", value: "4.5티어" },
          { name: "5티어", value: "5티어" }, { name: "새싹티어", value: "새싹티어" },
          { name: "미분류", value: "미분류" }
      ))
      .addStringOption(o => o.setName("세부등급").setDescription("해당 티어 내에서의 실력 위치").setRequired(true).addChoices(
          { name: "상 (위 티어에 가까움 ⬆️)", value: "상" },
          { name: "중 (해당 티어에 딱 맞음)", value: "중" },
          { name: "하 (아래 티어에 가까움 ⬇️)", value: "하" }
      )),
    new SlashCommandBuilder().setName("티어삭제").setDescription("클랜원의 티어 정보를 DB에서 삭제합니다 (관리자 전용)")
      .addUserOption(o => o.setName("유저").setDescription("대상을 선택하세요").setRequired(true)),
	new SlashCommandBuilder().setName("미분류정리").setDescription("DB에 남은 기존 용병(미분류) 데이터를 일괄 삭제합니다 (관리자 전용)"),
    
    new SlashCommandBuilder().setName("참여도설정").setDescription("월간 내전 참여도 랭킹 현황판을 채널에 고정합니다 (관리자 전용)"),
    new SlashCommandBuilder().setName("월간초기화").setDescription("모든 인원의 참여도를 0으로 리셋합니다 (새로운 월 시작용, 관리자 전용)"),
    new SlashCommandBuilder().setName("참여도추가").setDescription("특정 유저의 참여도를 수동으로 추가 또는 차감합니다 (관리자 전용)")
      .addUserOption(o => o.setName("유저").setDescription("대상을 선택하세요").setRequired(true))
      .addIntegerOption(o => o.setName("수치").setDescription("추가할 숫자 (차감하려면 마이너스 입력)").setRequired(true)),
    // 💡 [추가] 성별 설정 명령어
    new SlashCommandBuilder().setName("성별설정").setDescription("성별 선택(man/woman) 버튼을 생성합니다 (관리자 전용)"),
    // 💡 [추가] 고정메세지 및 해제 명령어
    new SlashCommandBuilder().setName("고정메세지").setDescription("특정 채널에 고정(스티키) 메세지를 설정합니다 (관리자 전용)")
      .addChannelOption(o => o.setName("채널").setDescription("고정 메세지를 띄울 채널").setRequired(true))
      .addStringOption(o => o.setName("메세지").setDescription("출력할 메세지 내용 (줄바꿈은 \\n 입력)").setRequired(true)),
    new SlashCommandBuilder().setName("고정해제").setDescription("특정 채널의 고정 메세지를 삭제하고 해제합니다 (관리자 전용)")
      .addChannelOption(o => o.setName("채널").setDescription("해제할 채널").setRequired(true))
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    
    db.run(`CREATE TABLE IF NOT EXISTS sticky_messages (channel_id TEXT PRIMARY KEY, message TEXT, last_msg_id TEXT)`);
    console.log("✅ 봇 구동 완료! (글로벌 명령어 적용 완료)");
  } catch (error) { console.error(error); }

  setInterval(checkTempChannels, 1000 * 60 * 60);
  checkTempChannels();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {

      if (interaction.commandName === "투표") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_vote_setup").setLabel("입력하기").setStyle(ButtonStyle.Success));
        await interaction.reply({ embeds: [new EmbedBuilder().setTitle("⚔️ 투표 설정").setDescription("버튼을 눌러 투표 정보를 입력하세요.").setColor(0x5865F2)], components: [row] });
      }

      // 📌 수정된 부분: 허공에 떠있던 잔해 코드 삭제 및 구조 정상화
      if (interaction.commandName === "참여도설정") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        
        const embed = new EmbedBuilder()
          .setTitle("📊 월간 내전 참여도 현황 (실시간)")
          .setDescription("데이터 로딩 중...")
          .setColor(0xE67E22);
          
        const msg = await interaction.channel.send({ embeds: [embed] });
        db.run(`INSERT OR REPLACE INTO participation_board_config (guild_id, channel_id, message_id) VALUES (?, ?, ?)`, [guildId, interaction.channel.id, msg.id], () => {
           updateParticipationBoard(client);
        });
        interaction.reply({ content: "✅ 실시간 참여도판이 생성되었습니다.", flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "참여도추가") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser("유저");
        const amount = interaction.options.getInteger("수치");
        
        db.get(`SELECT discord_id, nickname, participation_count FROM players WHERE discord_id = ?`, [target.id], (err, row) => {
          if (err) return interaction.reply({ content: "❌ DB 조회 오류", flags: MessageFlags.Ephemeral });
          
          if (!row) {
            const initialCount = Math.max(0, amount);
            db.run(`INSERT INTO players (discord_id, nickname, tier, sub_tier, participation_count) VALUES (?, ?, '미분류', '중', ?)`, 
              [target.id, target.username, initialCount], () => {
                // 💡 [트리거 적용] 신규 데이터 등록 시 갱신
                updateParticipationBoard(client);
                interaction.reply({ content: `✅ <@${target.id}> 님의 데이터가 없어 새로 등록하며 참여도(${amount})가 반영되었습니다.`, flags: MessageFlags.Ephemeral });
              });
          } else {
            const newCount = Math.max(0, (row.participation_count || 0) + amount);
            db.run(`UPDATE players SET participation_count = ? WHERE discord_id = ?`, [newCount, target.id], () => {
              updateParticipationBoard(client);
              interaction.reply({ content: `✅ <@${target.id}> 님의 참여도가 수정되었습니다. (현재: **${newCount}회**, 변동: \`${amount > 0 ? '+' + amount : amount}\`)`, flags: MessageFlags.Ephemeral });
            });
          }
        });
      }

      if (interaction.commandName === "월간초기화") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        
        db.run(`UPDATE players SET participation_count = 0`, function(err) {
          if (err) return interaction.reply({ content: "❌ 초기화 중 오류가 발생했습니다.", flags: MessageFlags.Ephemeral });
          
          updateParticipationBoard(client);
          interaction.reply({ content: `✅ **새로운 달이 시작되었습니다!** 모든 인원의 참여도가 0으로 초기화되었습니다.`, flags: MessageFlags.Ephemeral });
        });
      }

      if (interaction.commandName === "티어판설정") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle("🏆 Psycho 클랜 실시간 티어 현황").setDescription("데이터 로딩 중...").setColor(0x3498db);
        const msg = await interaction.channel.send({ embeds: [embed] });
        db.run(`INSERT OR REPLACE INTO tier_board_config (guild_id, channel_id, message_id) VALUES (?, ?, ?)`, [guildId, interaction.channel.id, msg.id], () => {
           updateTierBoard(client);
        });
        interaction.reply({ content: "✅ 실시간 티어판이 생성되었습니다.", flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "티어설정") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser("유저");
        const tier = interaction.options.getString("티어");
        const subTier = interaction.options.getString("세부등급"); 
        const member = await interaction.guild.members.fetch(target.id).catch(()=>null);
        const displayName = member ? member.displayName : target.username;

        // 💡 수정된 부분: 기존 유저의 참여도를 먼저 가져와서 보존합니다.
        db.get(`SELECT participation_count FROM players WHERE discord_id = ?`, [target.id], (err, row) => {
          const pCount = row ? row.participation_count : 0; // 기존 참여도가 없으면 0으로 시작
          
          db.run(`INSERT OR REPLACE INTO players (discord_id, nickname, tier, sub_tier, participation_count) VALUES (?, ?, ?, ?, ?)`, 
            [target.id, displayName, tier, subTier, pCount], (err) => {
              if (err) console.error("티어 설정 중 DB 오류:", err);
              updateTierBoard(client);
              updateParticipationBoard(client); // 티어가 바뀌면 참여도판에도 즉시 반영
              interaction.reply({ content: `✅ <@${target.id}> 님의 티어가 **[${tier}] (${subTier})** (으)로 설정(보존)되었습니다.`, flags: MessageFlags.Ephemeral });
          });
        });
      }

      if (interaction.commandName === "티어삭제") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const target = interaction.options.getUser("유저");
        
        db.run(`DELETE FROM players WHERE discord_id = ?`, [target.id], function(err) {
            updateTierBoard(client);
            interaction.reply({ content: `✅ <@${target.id}> 님의 티어 및 DB 정보가 삭제되었습니다.`, flags: MessageFlags.Ephemeral });
        });
      }

      if (interaction.commandName === "미분류정리") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        
        db.run(`DELETE FROM players WHERE tier = '미분류'`, function(err) {
            updateTierBoard(client);
            interaction.reply({ content: `🧹 예전 찌꺼기 데이터(미분류) **${this.changes}명**이 일괄 삭제되었습니다!\n(이제 직접 티어를 설정한 인원만 노출됩니다.)`, flags: MessageFlags.Ephemeral });
        });
      }

      if (interaction.commandName === "건의설정") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder()
          .setTitle("📬 클랜 건의함")
          .setDescription(
  `클랜의 원활한 운영을 위해 건의사항을 받습니다. 관리자 답변 완료 시, \n상단 1:1대화방에서 확인할 수 있습니다.

> **💡 건의 (기명)** : 관리자에게 기명으로 건의사항을 전달합니다.
> **👻 건의 (익명)** : 관리자에게 익명으로 건의사항을 전달합니다.`

)
          .setColor(0x3498DB);
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_req_sugg_named").setLabel("💡 건의 (기명)").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_req_suggestion").setLabel("👻 건의 (익명)").setStyle(ButtonStyle.Secondary)
        );
        
        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ 건의 버튼 생성 완료", flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "룰렛") {
        await interaction.reply({ content: "🎰 **맵 룰렛 머신이 돌아갑니다!**" });
        const maps = ["드래곤로드", "프로방스", "시티캣", "크로스포트", "올드타운"];
        for (let i = maps.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [maps[i], maps[j]] = [maps[j], maps[i]];
        }
        setTimeout(async () => {
          const resEmbed = new EmbedBuilder()
            .setTitle("🎯 맵 룰렛 결과")
            .setColor(0xE74C3C)
            .setDescription(`**1순위:** ${maps[0]}\n**2순위:** ${maps[1]}\n**3순위:** ${maps[2]}\n**4순위:** ${maps[3]}\n**5순위:** ${maps[4]}`)
            .setFooter({ text: "공정한 룰렛 결과입니다." });
          await interaction.editReply({ content: "✨ **결과가 나왔습니다!**", embeds: [resEmbed] });
        }, 1500);
      }

      if (interaction.commandName === "청소") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const amount = interaction.options.getInteger("개수");
        const deleted = await interaction.channel.bulkDelete(amount, true);
        interaction.reply({ content: `🧹 **${deleted.size}개** 삭제 완료.`, flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "방생성설정") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle("🔊 음성 채널 생성").setDescription("원하시는 카테고리의 버튼을 눌러 음성 채널을 생성하세요.").setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("create_voice_civil").setLabel("내전").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("create_voice_rank").setLabel("랭크").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("create_voice_clan").setLabel("클랭").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("create_voice_game").setLabel("종겜").setStyle(ButtonStyle.Secondary)
        );
        await interaction.channel.send({ embeds: [embed], components: [row] });
        interaction.reply({ content: "✅ 방 생성 버튼 세팅 완료", flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === "인증설정") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        
        // 💡 임베드 메시지 디자인
        const authEmbed = new EmbedBuilder()
          .setTitle("✅ 인증 신청") // 👈 맨 위 굵은 제목
          .setDescription("디스코드 서버 이용을 위해 인증을 진행해주세요.\n아래의 **[신청]** 버튼을 누르면 관리자에게 알림이 전송됩니다.\n인증이 완료되면 '✅인증' 에서 성별을 선택해주세요.\n\n**채널이 공개되면 공지, 기능 채널 필독바랍니다.**") // 👈 봇이 할 안내 문구 (줄바꿈은 \n 사용)
          .setColor(0x2F3136);

        // 💡 버튼 디자인
        const authRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("request_auth").setLabel("신청").setStyle(ButtonStyle.Success) // 👈 버튼에 적힐 글자
        );

        await interaction.channel.send({ embeds: [authEmbed], components: [authRow] });
        interaction.reply({ content: "✅ 인증 버튼 생성 완료", flags: MessageFlags.Ephemeral });
      }
	if (interaction.commandName === "성별설정") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        
        const genderEmbed = new EmbedBuilder()
          .setTitle("🚻 성별 선택")
          .setDescription("본인의 성별에 맞는 버튼을 클릭하여 역할을 부여받으세요.")
          .setColor(0x9B59B6);
          
        const genderRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_gender_man").setLabel("🙋‍♂️ 남자 (Man)").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_gender_woman").setLabel("🙋‍♀️ 여자 (Woman)").setStyle(ButtonStyle.Danger)
        );
        
        await interaction.channel.send({ embeds: [genderEmbed], components: [genderRow] });
        interaction.reply({ content: "✅ 성별 설정 버튼 생성 완료", flags: MessageFlags.Ephemeral });
      } // 👈 여기서 성별설정 괄호가 깔끔하게 닫힙니다.

      // 💡 [추가] 고정메세지 설정 로직
      if (interaction.commandName === "고정메세지") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        
        const channel = interaction.options.getChannel("채널");
        const messageText = interaction.options.getString("메세지").replace(/\\n/g, '\n'); 

        const sentMsg = await channel.send({ content: messageText }).catch(() => null);
        if (!sentMsg) return interaction.reply({ content: "❌ 해당 채널에 메세지를 보낼 수 없습니다. 봇 권한을 확인해주세요.", flags: MessageFlags.Ephemeral });

        db.run(`INSERT OR REPLACE INTO sticky_messages (channel_id, message, last_msg_id) VALUES (?, ?, ?)`, [channel.id, messageText, sentMsg.id], () => {
          interaction.reply({ content: `✅ <#${channel.id}> 채널에 고정 메세지가 성공적으로 설정되었습니다!`, flags: MessageFlags.Ephemeral });
        });
      }

      // 💡 [추가] 고정메세지 해제 로직
      if (interaction.commandName === "고정해제") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 권한 없음", flags: MessageFlags.Ephemeral });
        const channel = interaction.options.getChannel("채널");

        db.get(`SELECT last_msg_id FROM sticky_messages WHERE channel_id = ?`, [channel.id], async (err, row) => {
          if (row && row.last_msg_id) {
              const oldMsg = await channel.messages.fetch(row.last_msg_id).catch(() => null);
              if (oldMsg) await oldMsg.delete().catch(() => {}); 
          }
          db.run(`DELETE FROM sticky_messages WHERE channel_id = ?`, [channel.id], () => {
            interaction.reply({ content: `✅ <#${channel.id}> 채널의 고정 메세지가 삭제 및 해제되었습니다.`, flags: MessageFlags.Ephemeral });
          });
        });
      }

      if (interaction.commandName === "대화") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const t = interaction.options.getUser("상대");
        const tm = await interaction.guild.members.fetch(t.id).catch(()=>null);
        if(!tm) return interaction.editReply("유저 없음");
        const c = await interaction.guild.channels.create({ 
            name: `💬-${interaction.member.displayName}-${tm.displayName}`, 
            type: ChannelType.GuildText, 
            parent: interaction.guild.channels.cache.find(c=>c.name===TALK_CATEGORY_NAME)?.id, 
            permissionOverwrites: [
                {id:interaction.guild.id, deny:[PermissionsBitField.Flags.ViewChannel]}, 
                {id:interaction.user.id, allow:[PermissionsBitField.Flags.ViewChannel]}, 
                {id:t.id, allow:[PermissionsBitField.Flags.ViewChannel]}
            ] 
        });
        c.send({ content: `🔒 대화방`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("close_talk").setLabel("종료").setStyle(ButtonStyle.Danger))] });
        interaction.editReply("✅ 완료");
      }
    }

    if (interaction.isButton()) {

      if (interaction.customId === "start_vote_setup") {
        const modal = new ModalBuilder().setCustomId("vote_modal").setTitle("투표 설정");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("제목").setStyle(TextInputStyle.Short).setValue("대룰 내전")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("내용").setStyle(TextInputStyle.Short).setValue(getKoreanDate())),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("opt1").setLabel("항목 1").setStyle(TextInputStyle.Short).setValue("스나이퍼")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("opt2").setLabel("항목 2").setStyle(TextInputStyle.Short).setValue("라이플")),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("opt3").setLabel("항목 3").setStyle(TextInputStyle.Short).setValue("멀티수"))
        );
        await interaction.showModal(modal);
      }

      if (interaction.customId === "btn_req_sugg_named") {
        const modal = new ModalBuilder().setCustomId("modal_sugg_named_submit").setTitle("💡 건의 (기명)");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sg_content").setLabel("어떤 점이 불편하신가요?").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        await interaction.showModal(modal);
      }

      if (interaction.customId === "btn_req_suggestion") {
        const modal = new ModalBuilder().setCustomId("modal_suggestion_submit").setTitle("👻 건의 (익명 전달)");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("sg_content").setLabel("어떤 점이 불편하신가요?").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        await interaction.showModal(modal);
      }

      if (interaction.customId.startsWith("reply_sugg_")) {
        const targetId = interaction.customId.replace("reply_sugg_", "");
        const modal = new ModalBuilder().setCustomId(`modal_sugg_reply_${targetId}`).setTitle("📨 건의사항 답변하기");
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reply_content").setLabel("답변 내용").setStyle(TextInputStyle.Paragraph).setRequired(true))
        );
        await interaction.showModal(modal);
      }

      if (interaction.customId === "close_temp_channel") {
        await interaction.channel.delete().catch(()=>{});
        db.run(`DELETE FROM temp_channels WHERE channel_id = ?`, [interaction.channel.id]);
      }

      if (interaction.customId === "vote_end") {
        if (!isVoteManager(interaction.member)) return interaction.reply({ content: "❌ 관리자만 종료할 수 있습니다.", flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const message = await interaction.message.fetch(); 
            const embed = message.embeds[0];
            
            const sValue = embed.fields[0].value;
            const rValue = embed.fields[1].value;
            const mValue = embed.fields[2].value;

            const sNames = sValue !== "없음" ? sValue.split(", ") : [];
            const rNames = rValue !== "없음" ? rValue.split(", ") : [];
            const mNames = mValue !== "없음" ? mValue.split(", ") : [];
            const total = sNames.length + rNames.length + mNames.length;

            db.all(`SELECT user_id FROM live_votes WHERE message_id = ?`, [message.id], (err, vRows) => {
              if (!err && vRows) {
                vRows.forEach(vr => {
                  db.run(`UPDATE players SET participation_count = participation_count + 1 WHERE discord_id = ?`, [vr.user_id]);
                });
              }
            });

            const summaryEmbed = new EmbedBuilder()
              .setTitle("🏁 대내 신청 결과 (투표 종료)")
              .setDescription(`총 신청 인원: **${total}명**`)
              .addFields(
                { name: `${EMOJI_S} 스나이퍼 (${sNames.length}명)`, value: sValue },
                { name: `${EMOJI_R} 라이플 (${rNames.length}명)`, value: rValue },
                { name: `${EMOJI_M} 멀티수 (${mNames.length}명)`, value: mValue }
              ).setColor(0x000000);

            await interaction.channel.send({ embeds: [summaryEmbed] });

            const logChannel = interaction.guild.channels.cache.find(c => c.name === AUTH_LOG_CHANNEL_NAME);
            if (logChannel) {
              db.all(`SELECT nickname, tier, sub_tier FROM players`, async (err, playerRows) => {
                if(err) return;
                const logEmbed = new EmbedBuilder()
                  .setTitle("⚖️ 신청자 티어별 분포")
                  .addFields(
                    { name: `${EMOJI_S} 스나이퍼`, value: formatByTierDB(sNames, playerRows) },
                    { name: `${EMOJI_R} 라이플`, value: formatByTierDB(rNames, playerRows) },
                    { name: `${EMOJI_M} 멀티수`, value: formatByTierDB(mNames, playerRows) }
                  ).setColor(0x3498db);
                await logChannel.send({ embeds: [logEmbed] });
              });
            }

            await message.delete();
            db.run(`DELETE FROM live_votes WHERE message_id = ?`, [message.id], () => {
                // 💡 [트리거 적용] 투표 종료 시 갱신
                updateParticipationBoard(client);
            });
            await interaction.editReply("✅ 투표가 성공적으로 종료되었으며 명단이 정리 및 실시간 참여도판에 반영되었습니다.");
        } catch (e) {
            interaction.editReply("❌ 투표 종료 중 오류가 발생했습니다.");
        }
      }

      if (interaction.customId.startsWith("create_voice_")) {
        const type = interaction.customId.replace("create_voice_", "");
        let categoryName = "";

        if (type === "civil") categoryName = "CIVIL WAR";
        else if (type === "rank") categoryName = "RANK";
        else if (type === "clan") categoryName = "CLAN RANK";
        else if (type === "game") categoryName = "🎮";

        const parent = interaction.guild.channels.cache.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
        if (!parent) return interaction.reply({ content: `❌ **${categoryName}** 카테고리를 찾을 수 없습니다. (디스코드 카테고리 이름을 확인해주세요)`, flags: MessageFlags.Ephemeral });

        const channels = parent.children.cache.filter(c => c.type === ChannelType.GuildVoice);
        const nums = channels.map(c => { const m = c.name.match(/^(\d+)번 채널/); return m ? parseInt(m[1]) : null; }).filter(n => n !== null).sort((a, b) => a - b);
        let newNum = 1; for (const n of nums) { if (n === newNum) newNum++; else break; }

        const chan = await interaction.guild.channels.create({ name: `${newNum}번 채널`, type: ChannelType.GuildVoice, parent: parent.id });
        interaction.reply({ content: `✅ **${categoryName}** 카테고리에 **${chan.name}** 생성 완료 (30초 내 미입장 시 자동 폭파)`, flags: MessageFlags.Ephemeral });

        setTimeout(async () => {
          const ch = await interaction.guild.channels.fetch(chan.id).catch(() => null);
          if (ch && ch.members.size === 0) await ch.delete().catch(() => {});
        }, 30000);
      }

      if (interaction.customId === "request_auth") {
        const log = interaction.guild.channels.cache.find(c=>c.name===AUTH_LOG_CHANNEL_NAME);
        if(log) log.send({ embeds: [new EmbedBuilder().setTitle("📩 인증요청").setDescription(`<@${interaction.user.id}>`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`approve_auth_${interaction.user.id}`).setLabel("승인").setStyle(ButtonStyle.Success))] });
        interaction.reply({ content: "✅ 완료", flags: MessageFlags.Ephemeral });
      }
	if (interaction.customId === "btn_gender_man" || interaction.customId === "btn_gender_woman") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        const isMan = interaction.customId === "btn_gender_man";
        const targetRoleName = isMan ? "Man" : "Woman";
        const removeRoleName = isMan ? "Woman" : "Man"; 
        
        // 💡 필요한 4가지 역할 찾기 (이름이 서버와 완벽히 똑같아야 함)
        const targetRole = interaction.guild.roles.cache.find(r => r.name === targetRoleName);
        const removeRole = interaction.guild.roles.cache.find(r => r.name === removeRoleName);
        const unauthRole = interaction.guild.roles.cache.find(r => r.name === UNAUTH_ROLE_NAME); // 👈 맨 위에서 설정한 공식 상수를 그대로 씁니다!
        const gamerRole = interaction.guild.roles.cache.find(r => r.name === "서든러");
        
        if (!targetRole) return interaction.editReply(`❌ 서버에 '${targetRoleName}' 역할이 없습니다.`);
        if (!gamerRole) return interaction.editReply(`❌ 서버에 '서든러' 역할이 없습니다.`);
        
        try {
          // 1. 반대 성별 역할 제거 (실수 대비)
          if (removeRole && interaction.member.roles.cache.has(removeRole.id)) {
            await interaction.member.roles.remove(removeRole);
          }
          
          // 2. '미인증인원' 역할 제거
          if (unauthRole && interaction.member.roles.cache.has(unauthRole.id)) {
            await interaction.member.roles.remove(unauthRole);
          }
          
          // 3. 선택한 성별 역할과 서든러 역할을 동시에 부여! (배열로 묶어서 한 번에 처리)
          await interaction.member.roles.add([targetRole, gamerRole]);
          
          interaction.editReply(`✅ 정식 가입을 환영합니다! **${targetRoleName}** 및 **서든러** 역할이 부여되었으며, 미인증 상태가 해제되었습니다.`);
        } catch (e) {
          console.error("성별/서든러 역할 처리 중 오류:", e);
          interaction.editReply("❌ 역할 처리 실패! 봇의 역할 위치가 '서든러'나 '미인증인원'보다 위쪽에 있는지 꼭 확인해 주세요.");
        }
      }

      if (interaction.customId.startsWith("approve_auth_")) {
        const id = interaction.customId.replace("approve_auth_", "");
        const m = await interaction.guild.members.fetch(id).catch(()=>null);
        
        if (m) {
          const newRole = interaction.guild.roles.cache.find(r => r.name === NEW_ROLE_NAME);
          const unauthRole = interaction.guild.roles.cache.find(r => r.name === UNAUTH_ROLE_NAME);
          
          // 1. 역할이 서버에 존재하는지부터 검사
          if (!unauthRole) {
            return interaction.reply({ content: `❌ 서버에 **'${UNAUTH_ROLE_NAME}'** 역할이 없습니다. (띄어쓰기까지 코드와 완벽히 똑같아야 합니다!)`, flags: MessageFlags.Ephemeral });
          }

          try {
            // 2. 역할 빼고 넣기
            if (newRole && m.roles.cache.has(newRole.id)) {
              await m.roles.remove(newRole);
            }
            await m.roles.add(unauthRole);
            
            // 3. 성공 시 원래 있던 승인 버튼 메시지 업데이트
            await interaction.update({ content: `✅ <@${id}> 님의 인증이 성공적으로 승인되었으며 역할을 부여했습니다.`, embeds: [], components: [] });
          } catch (error) {
            // 권한이 없어서 실패했을 경우
            await interaction.reply({ content: `❌ 역할 부여 실패! 봇의 역할 위치가 **'${UNAUTH_ROLE_NAME}'** 보다 위에 있는지 확인해 주세요.`, flags: MessageFlags.Ephemeral });
          }
        } else {
          await interaction.update({ content: `❌ 서버를 나갔거나 찾을 수 없는 유저입니다.`, embeds: [], components: [] });
        }
      }

      if (interaction.customId === "close_talk") await interaction.channel.delete();

      if (interaction.customId.startsWith("btn_vote_")) {
        const type = interaction.customId.replace("btn_vote_", ""); 
        const msgId = interaction.message.id;
        const userId = interaction.user.id;
        const userName = interaction.member.displayName;

        if (type === "cancel") {
          db.run(`DELETE FROM live_votes WHERE message_id = ? AND user_id = ?`, [msgId, userId], () => {
            updateVoteEmbed(interaction.message);
            interaction.reply({ content: "❌ 투표가 취소되었습니다.", flags: MessageFlags.Ephemeral });
          });
        } else {
          db.run(`INSERT OR REPLACE INTO live_votes (message_id, user_id, user_name, vote_type) VALUES (?, ?, ?, ?)`, [msgId, userId, userName, type], () => {
            updateVoteEmbed(interaction.message);
            interaction.reply({ content: "✅ 투표가 완료되었습니다!", flags: MessageFlags.Ephemeral });
          });
        }
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "vote_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = interaction.guild.channels.cache.find(c => c.name === VOTE_CHANNEL_NAME);
        if (!channel) return interaction.editReply(`❌ '${VOTE_CHANNEL_NAME}' 채널을 찾을 수 없습니다. 채널 이름을 확인해주세요!`);

        const embed = new EmbedBuilder().setTitle(interaction.fields.getTextInputValue("title")).setDescription(interaction.fields.getTextInputValue("desc")).addFields(
          { name: EMOJI_S + " 스나이퍼 (0명)", value: "없음" },
          { name: EMOJI_R + " 라이플 (0명)", value: "없음" },
          { name: EMOJI_M + " 멀티수 (0명)", value: "없음" }
        ).setColor(0x5865F2).setFooter({ text: `📊 [투표 인원] 총 0명 참여 중` });

        const voteRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("btn_vote_s").setLabel("🇸 스나").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("btn_vote_r").setLabel("🇷 라플").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("btn_vote_m").setLabel("🇲 멀티").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("btn_vote_cancel").setLabel("❌ 취소").setStyle(ButtonStyle.Secondary)
        );
        const endRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("vote_end").setLabel("투표 종료 (관리자)").setStyle(ButtonStyle.Danger)
        );

        await channel.send({ embeds: [embed], components: [voteRow, endRow] });
        interaction.editReply("✅ 투표가 성공적으로 생성되었습니다.");
      }

      if (interaction.customId === "modal_sugg_named_submit") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const content = interaction.fields.getTextInputValue("sg_content");
        
        const targetChannel = interaction.guild.channels.cache.find(c => c.name === FEEDBACK_CHANNEL_NAME);
        if (targetChannel) {
            const embed = new EmbedBuilder()
                .setTitle("💡 새로운 건의사항 (기명)")
                .addFields(
                    { name: "작성자", value: `${interaction.member.displayName} (<@${interaction.user.id}>)` },
                    { name: "건의 내용", value: content }
                )
                .setColor(0x3498DB).setTimestamp();
                
            // 기명 건의도 관리자가 바로 답장할 수 있게 버튼 생성
            const replyRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`reply_sugg_${interaction.user.id}`).setLabel("답장하기 (관리자용)").setStyle(ButtonStyle.Secondary)
            );
            await targetChannel.send({ embeds: [embed], components: [replyRow] });
        }
        interaction.editReply("✅ 건의사항이 접수되었습니다.");
      }

      if (interaction.customId === "modal_suggestion_submit") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const content = interaction.fields.getTextInputValue("sg_content");
        
        const feedbackChannel = interaction.guild.channels.cache.find(c => c.name === FEEDBACK_CHANNEL_NAME);
        const logChannel = interaction.guild.channels.cache.find(c => c.name === LOG_CHANNEL_NAME);
        
        if (feedbackChannel) {
            const anonEmbed = new EmbedBuilder()
                .setTitle("💡 새로운 건의사항 (익명)")
                .setDescription(content)
                .setColor(0x95A5A6).setTimestamp();
            
            const replyRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`reply_sugg_${interaction.user.id}`).setLabel("답장하기 (관리자용)").setStyle(ButtonStyle.Secondary)
            );
            await feedbackChannel.send({ embeds: [anonEmbed], components: [replyRow] });
        }
        
        if (logChannel) {
            const realEmbed = new EmbedBuilder()
                .setTitle("💡 [오너용 특수 로그] 건의사항 원본")
                .addFields(
                    { name: "실제 작성자", value: `${interaction.member.displayName} (<@${interaction.user.id}>)` },
                    { name: "제출 내용", value: content }
                )
                .setColor(0xE74C3C).setTimestamp();
            await logChannel.send({ embeds: [realEmbed] });
        }
        interaction.editReply("✅ 건의사항이 익명으로 접수되었습니다.");
      }

      if (interaction.customId.startsWith("modal_sugg_reply_")) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetId = interaction.customId.replace("modal_sugg_reply_", "");
        const replyContent = interaction.fields.getTextInputValue("reply_content");
        
        if (interaction.message) {
            const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
            originalEmbed.setColor(0x7F8C8D);
            originalEmbed.setFooter({ text: "✅ 처리 완료 (답변 전송됨)" });
            
            await interaction.message.edit({ embeds: [originalEmbed], components: [] }).catch(()=>{});
        }

        const privateChannel = await interaction.guild.channels.create({
            name: `📩-건의답변-익명`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: targetId, allow: [PermissionsBitField.Flags.ViewChannel] },
                { id: interaction.guild.ownerId, allow: [PermissionsBitField.Flags.ViewChannel] }
            ]
        });

        const expireTime = new Date();
        expireTime.setHours(expireTime.getHours() + 48);
        db.run(`INSERT INTO temp_channels (channel_id, expire_at) VALUES (?, ?)`, [privateChannel.id, expireTime.toISOString()]);

        const replyEmbed = new EmbedBuilder()
            .setTitle("📨 익명 건의사항에 대한 관리자의 답변이 도착했습니다.")
            .setDescription(replyContent)
            .setColor(0x2ECC71)
            .setFooter({ text: "종료버튼을 누르거나 답변이 도착하고 2일이 지나면 자동삭제됩니다." })
            .setTimestamp();
            
        const closeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("close_temp_channel").setLabel("종료").setStyle(ButtonStyle.Danger)
        );

        await privateChannel.send({ content: `<@${targetId}>`, embeds: [replyEmbed], components: [closeRow] });
        interaction.editReply(`✅ 답변이 성공적으로 전송되었으며, <#${privateChannel.id}> 채널이 생성되었습니다.`);

        const logChannel = interaction.guild.channels.cache.find(c => c.name === LOG_CHANNEL_NAME);
        if (logChannel) {
            const adminLogEmbed = new EmbedBuilder()
                .setTitle("🕵️ [건의사항 답변 완료 로그]")
                .addFields(
                    { name: "답변 처리한 관리자", value: `${interaction.member.displayName} (<@${interaction.user.id}>)` },
                    { name: "건의 대상자", value: `<@${targetId}>` },
                    { name: "답변 내용", value: replyContent }
                )
                .setColor(0x34495E).setTimestamp();
            await logChannel.send({ embeds: [adminLogEmbed] });
        }
      }
    }
  } catch (err) {
    console.error(err);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  // 💡 [추가] 서버 입장 시 'new' 역할 자동 부여
  const newRole = member.guild.roles.cache.find(r => r.name === NEW_ROLE_NAME);
  if (newRole) {
    member.roles.add(newRole).catch(() => console.error("오토롤 부여 실패: 권한 부족"));
  }

  const logChannel = member.guild.channels.cache.find(c => c.name === LOG_CHANNEL_NAME);
  if (logChannel) logChannel.send({ embeds: [new EmbedBuilder().setTitle("📥 [서버 입장]").setDescription(`<@${member.id}> (${member.user.username}) 님이 서버에 접속했습니다. (new 역할 자동 부여 시도)`).setColor(0x2ECC71).setTimestamp()]});
});

client.on(Events.MessageCreate, async (message) => {
  // 봇이 쓴 채팅이면 무한루프 방지를 위해 무시
  if (message.author.bot) return;

  // DB에 이 채널이 고정 메세지가 설정된 채널인지 검색
  db.get(`SELECT message, last_msg_id FROM sticky_messages WHERE channel_id = ?`, [message.channel.id], async (err, row) => {
    if (!row) return; // 설정된 게 없으면 그냥 통과

    // 1. 기존에 떠있던 고정 메세지가 있다면 삭제
    if (row.last_msg_id) {
      try {
        const oldMsg = await message.channel.messages.fetch(row.last_msg_id).catch(() => null);
        if (oldMsg) await oldMsg.delete().catch(() => {});
      } catch(e) {}
    }

    // 2. 새 메세지를 맨 아래로 다시 보내고, 그 ID를 DB에 갱신
    try {
      const newMsg = await message.channel.send({ content: row.message });
      db.run(`UPDATE sticky_messages SET last_msg_id = ? WHERE channel_id = ?`, [newMsg.id, message.channel.id]);
    } catch(e) {
      console.error("고정 메세지 갱신 실패:", e);
    }
  });
});

client.on(Events.GuildMemberRemove, async (member) => {
  const logChannel = member.guild.channels.cache.find(c => c.name === LOG_CHANNEL_NAME);
  if (logChannel) {
      logChannel.send({ embeds: [new EmbedBuilder().setTitle("📤 [서버 퇴장]").setDescription(`**${member.user.username}** 님이 서버에서 나갔습니다. (DB 티어 기록이 삭제됩니다)`).setColor(0xE74C3C).setTimestamp()]});
  }

  db.run(`DELETE FROM players WHERE discord_id = ?`, [member.id], function(err) {
      if (!err && this.changes > 0) {
          updateTierBoard(client);
          // 💡 [트리거 적용] 퇴장 시 갱신
          updateParticipationBoard(client);
      }
  });
});

client.on(Events.MessageDelete, async (message) => {
  if (message.author?.bot) return;
  const logChannel = message.guild?.channels.cache.find(c => c.name === LOG_CHANNEL_NAME);
  if (logChannel && message.content) logChannel.send({ embeds: [new EmbedBuilder().setTitle("🗑️ [메시지 삭제]").setDescription(`**유저:** <@${message.author.id}>\n**채널:** <#${message.channel.id}>\n**내용:** ${message.content}`).setColor(0xE91E63).setTimestamp()]});
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (oldMessage.author?.bot || oldMessage.content === newMessage.content) return;
  const logChannel = oldMessage.guild?.channels.cache.find(c => c.name === LOG_CHANNEL_NAME);
  if (logChannel && oldMessage.content && newMessage.content) logChannel.send({ embeds: [new EmbedBuilder().setTitle("✏️ [메시지 수정]").setDescription(`**유저:** <@${oldMessage.author.id}>\n**채널:** <#${oldMessage.channel.id}>\n**수정 전:** ${oldMessage.content}\n**수정 후:** ${newMessage.content}`).setColor(0xF1C40F).setTimestamp()]});
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const logChannel = oldMember.guild.channels.cache.find(c => c.name === LOG_CHANNEL_NAME);
  
  if (oldMember.displayName !== newMember.displayName) {
    const oldName = oldMember.displayName;
    const newName = newMember.displayName;
    
    if (logChannel) {
        logChannel.send({ embeds: [new EmbedBuilder().setTitle("🏷️ [닉네임 변경]").setDescription(`<@${newMember.id}> 님이 닉네임을 변경했습니다.\n**변경 전:** ${oldName}\n**변경 후:** ${newName}`).setColor(0x3498DB).setTimestamp()]});
    }

    // 💡 변경된 로직: DB에 유저가 있는지 먼저 검사합니다.
    db.get(`SELECT * FROM players WHERE discord_id = ?`, [newMember.id], (err, row) => {
        if (!row && newName.includes('/')) {
            // 데이터가 없는 신입이 닉네임에 '/'를 넣어서 양식을 맞췄을 때 -> 0회로 자동 등록!
            db.run(`INSERT INTO players (discord_id, nickname, tier, sub_tier, participation_count) VALUES (?, ?, '미분류', '중', 0)`, [newMember.id, newName], () => {
                updateTierBoard(client);
                updateParticipationBoard(client);
            });
        } else if (row) {
            // 이미 데이터가 있는 기존 유저일 때 -> 닉네임만 업데이트
            db.run(`UPDATE players SET nickname = ? WHERE discord_id = ?`, [newName, newMember.id], () => {
                updateTierBoard(client);
                updateParticipationBoard(client);
            });
        }
    });
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const channel = oldState.channel;
  if (channel && channel.members.size === 0 && /^\d+번 채널$/.test(channel.name)) {
    try { await channel.delete(); } catch (err) { console.error("채널 삭제 실패:", err); }
  }
});

client.login(token);