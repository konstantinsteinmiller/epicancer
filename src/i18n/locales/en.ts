// English source bundle. Single source of truth for translation keys — every
// new player-facing string gets a key here first; the per-language files in
// this folder mirror the shape. Vite ships each non-English locale as its own
// lazy chunk (see `src/i18n/index.ts`).
export default {
  // ── Midnight Analog ──────────────────────────────────────────────────────
  // The briefing verbs are the INSTRUCTION, not flavour: the player gets ~1.5s
  // and one word. Translations must stay short, imperative and unambiguous —
  // a long verb gets auto-shrunk to fit and loses its punch.
  'game': {
    'bossBanner': 'Boss Stage!',
    'saiyan': {
      'verb': 'Aaaahrg!',
      'hint': 'Mash to raise your power level',
      'pump': 'Pump!',
      'over': "It's over 9000!"
    },
    'cat': {
      'verb': 'Pet!',
      'hint': 'Tap each spark as its ring closes',
      'zap': 'Zap!'
    },
    'window': {
      'verb': 'Shut!',
      'hint': 'Drag the handle across to slam it',
      'slam': 'Slam!'
    },
    'flashlight': {
      'verb': 'Smack!',
      'hint': 'Smack it three times in rhythm',
      'whack': 'Whack!'
    },
    'toast': {
      'verb': 'Catch!',
      'hint': 'Catch both slices in the air'
    },
    'soda': {
      'verb': 'Tap!',
      'hint': 'Tap 5 times, then pop the tab',
      'spray': 'Splat!'
    },
    'router': {
      'verb': 'Connect!',
      'hint': 'Drag the plug into the socket'
    },
    'mosquito': {
      'verb': 'Swat!',
      'hint': 'Tap each one as the ring closes',
      'smack': 'Smack!'
    },
    'stomp': {
      'verb': 'Stomp!',
      'hint': 'Squash every bug before time runs out',
      'splat': 'Splat!'
    },
    'signal': {
      'verb': 'Tune it!',
      'hint': 'Circle the antenna to find the signal',
      'tune': 'Tune',
      'hold': 'Hold!'
    }
  },
  'gameName': 'Midnight Analog',
  // The framing story: the desk at 3AM, and the morning after.
  'desk': {
    'prompt': 'Press space to dream'
  },
  'summary': {
    'morning': 'Morning!',
    'lightsOut': 'Lights out.',
    'ideas': '3am ideas brought to life',
    'best': 'Best:',
    'newBest': 'New best!',
    'again': 'Stay up another night?'
  },
  'cancel': 'Cancel',
  'close': 'Close',
  'ok': 'Ok',
  'continue': 'Continue',
  'tapToContinue': 'Tap to continue',
  'clickToContinue': 'Click to continue',
  'stage': 'Stage',
  'rewards': 'REWARDS',
  'tip': 'Tip',
  'crazyGamesOnly': 'This game is only available on',
  'startTouch': 'Tap to Start',
  'startDesktop': 'Click to Start',
  'startSubhint': 'Roll upward — change direction to dodge the gaps and obstacles!',
  'hints': {
    'tapToTurn': 'Tap to change direction',
    'clickToTurn': 'Click / Space to change direction'
  },
  'powerups': {
    'invuln': 'Invincible',
    'magnet': 'Coin Magnet',
    'dodge': 'Dodge Master',
    'slowmo': 'Slow Motion',
    'push': 'Push Force',
    'racer': 'Racer!'
  },
  'secondChance': {
    'title': 'Keep rolling?',
    'body': 'Watch a short ad to revive and continue your run.',
    'watch': 'Watch & Continue',
    'skip': 'Skip'
  },
  'result': {
    'win': 'STAGE CLEAR!',
    'lose': 'GAME OVER',
    'fell': 'You fell into a gap!',
    'crashed': 'You crashed into an obstacle!',
    'tiles': 'Tiles',
    'winReward': 'incl. +{n} stage bonus',
    'double': 'Double coins',
    'firstRunDouble': '2× — first run today!',
    'almost': 'Almost! {n} more tiles to clear.',
    'retry': 'Retry'
  },
  'ads': {
    'watch': 'Watch',
    'revive': 'Revive',
    'secondChance': 'Second Chance',
    'doubleCoins': '2× Coins',
    'plusCoins': '+{n} coins'
  },
  'achievements': {
    'title': 'Achievements',
    'subtitle': 'Hit lifetime milestones to earn coins.',
    'claim': 'Claim',
    'claimed': 'Claimed',
    'progress': '{c} / {t}',
    'items': {
      'tiles1k': { 'name': 'Globetrotter', 'desc': 'Travel 1,000 tiles in total.' },
      'tiles5k': { 'name': 'Marathoner', 'desc': 'Travel 5,000 tiles in total.' },
      'tiles10k': { 'name': 'Long Hauler', 'desc': 'Travel 10,000 tiles in total.' },
      'tiles100k': { 'name': 'Voyager', 'desc': 'Travel 100,000 tiles in total.' },
      'stage5': { 'name': 'Getting Started', 'desc': 'Reach stage 5.' },
      'stage10': { 'name': 'Seasoned', 'desc': 'Reach stage 10.' },
      'stage20': { 'name': 'Veteran', 'desc': 'Reach stage 20.' },
      'clears25': { 'name': 'Clearing House', 'desc': 'Clear 25 stages in total.' },
      'clears100': { 'name': 'Centurion', 'desc': 'Clear 100 stages in total.' },
      'bestRun100': { 'name': 'Sprinter', 'desc': 'Travel 100 tiles in a single run.' },
      'bestRun250': { 'name': 'Distance Demon', 'desc': 'Travel 250 tiles in a single run.' },
      'coins5k': { 'name': 'Coin Collector', 'desc': 'Collect 5,000 coins in total.' },
      'coins50k': { 'name': 'Treasurer', 'desc': 'Collect 50,000 coins in total.' },
      'items50': { 'name': 'Unboxer', 'desc': 'Grab 50 item boxes in total.' },
      'items250': { 'name': 'Hoarder', 'desc': 'Grab 250 item boxes in total.' }
    }
  },
  'missions': {
    'title': 'Daily Missions',
    'subtitle': 'Complete goals each day for coins.',
    'claim': 'Claim',
    'done': 'Claimed',
    'types': {
      'coins': 'Collect {n} coins today',
      'tiles': 'Travel {n} tiles in one run',
      'items': 'Grab {n} item boxes today',
      'clears': 'Clear {n} stages today'
    }
  },
  'endless': {
    'badge': 'Endless',
    'toEndless': 'Endless Mode',
    'toCampaign': 'Campaign',
    'best': 'Best: {n}'
  },
  'boon': {
    'title': 'Choose a boon',
    'names': {
      'secondChance': 'Second Chance',
      'startPowerup': 'Head Start',
      'coinBoost': 'Coin Rush'
    },
    'descriptions': {
      'secondChance': 'Begin the next stage with a Second Chance shield.',
      'startPowerup': 'Begin the next stage with a random power-up.',
      'coinBoost': '1.2× coins for the whole next stage.'
    }
  },
  'upgrades': {
    'title': 'Upgrades',
    'subtitle': 'Spend coins to power up permanently.',
    'level': 'Lv.{n}',
    'maxedOut': 'MAXED',
    'sellBack': 'Sell +{n}',
    'spotlight': 'Spend!',
    'unlocksAtStage': '🔒 Stage {n}',
    'names': {
      'powerupDuration': 'Power Boost',
      'magnetRange': 'Magnet Range',
      'coinValue': 'Coin Value',
      'itemLuck': 'Lucky Boxes',
      'dodgeApprentice': 'Dodge Apprentice',
      'deathMagnet': 'Death Magnet',
      'autoCollect': 'Auto-Collect',
      'rollingBoulder': 'Rolling Boulder'
    },
    'descriptions': {
      'powerupDuration': 'All power-ups last longer (+0.75s per level).',
      'magnetRange': 'The Coin Magnet reaches further.',
      'coinValue': 'Each coin you grab is worth more.',
      'itemLuck': 'Item boxes appear more often.',
      'dodgeApprentice': 'Auto-dodge one deadly tile, then recharge (10s; −0.5s per level).',
      'deathMagnet': 'On death, grab every coin within 4 tiles — bank what you would have lost.',
      'autoCollect': 'Always collect coins from nearby tiles — a permanent 1-tile magnet.',
      'rollingBoulder': 'Roll straight through box obstacles, unharmed.'
    },
    'secondChance': {
      'name': 'Second Chance',
      'description': 'Start each run with angel wings — survive one crash or fall. Active until used.',
      'active': 'ACTIVE',
      'watch': 'Free'
    }
  },
  'battlePass': {
    'title': 'Battle Pass',
    'progress': '{current} / {total}',
    'daysLeft': '{n}d left',
    'maxed': 'BATTLE PASS COMPLETE',
    'xpProgress': '{current} / {total} XP',
    'howToEarn': 'How to earn XP',
    'perAttempt': 'per run',
    'perStageFinish': 'per stage clear',
    'unlockHint': 'Reach {n} XP to unlock the next reward — unclaimed rewards stay until you tap them.'
  },
  'dailyRewards': {
    'title': 'Daily Rewards',
    'subtitle': 'Sign in every day to keep your streak.',
    'day': 'Day {n}',
    'dayShort': 'D{n}'
  },
  'skins': {
    'title': 'Ball Skins',
    'subtitle': 'Spend coins to unlock and equip new looks.',
    'equip': 'Equip',
    'equipped': 'Equipped',
    'locked': 'Stage {n}',
    'new': 'New!',
    'rarity': {
      'common': 'Common',
      'rare': 'Rare',
      'epic': 'Epic'
    }
  },
  'options': {
    'title': 'Options',
    'general': 'General',
    'audio': 'Audio',
    'language': 'Language',
    'difficulty': 'Difficulty',
    'soundEffects': 'Sound Effects',
    'music': 'Music',
    'musicTrack': 'Music Track',
    'musicTracks': {
      'cozy': 'Cozy Harmony',
      'trance': 'Trance Tunnel'
    },
    'close': 'Save & Close',
    'difficulties': {
      'easy': 'Easy',
      'medium': 'Medium',
      'hard': 'Hard'
    },
    'difficultyHints': {
      'easy': 'Slower travel speed — more time to react.',
      'medium': 'The standard, balanced pace.',
      'hard': 'Faster travel speed — tighter, more precise timing.'
    }
  },
  'adsBlocked': {
    'title': "Couldn't show ad",
    'body': 'We tried to show you a video so you could earn your reward, but something on your browser is blocking ads.',
    'allowPrefix': 'Please allow ads on',
    'allowSuffix': '(or pause your ad-blocker for this game) and try again.',
    'gotIt': 'Got it'
  },
  'saveStatus': {
    'restoredTitle': 'Cloud save restored',
    'restoredBody': '+{n} bonus coins for the recovery',
    'tap': 'tap',
    'pausedTitle': 'Cloud sync paused',
    'pausedBody': 'Playing offline. Your progress is saved here.',
    'retry': 'Retry',
    'dismiss': 'dismiss'
  },
  'loading': {
    'tooLong': 'Loading taking too long? Try disabling your ad blocker and refresh.'
  },
  'license': {
    'denied': 'Access Denied: Please purchase a license.'
  }
}
