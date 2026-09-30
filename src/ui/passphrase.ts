/** 256 short, friendly words: one random byte picks each, so every word carries exactly 8 bits. */
export const WORDS = [
  'able', 'acid', 'acorn', 'actor', 'adapt', 'agent', 'alarm', 'album',
  'alert', 'alien', 'alley', 'amber', 'ample', 'angel', 'angle', 'ankle',
  'apple', 'apron', 'arena', 'arrow', 'atlas', 'attic', 'aunt', 'award',
  'bacon', 'badge', 'bagel', 'baker', 'banjo', 'barn', 'basil', 'beach',
  'beard', 'bench', 'berry', 'bison', 'blade', 'blank', 'blaze', 'bloom',
  'boat', 'bonus', 'boots', 'brave', 'bread', 'brick', 'bridge', 'brook',
  'broom', 'brush', 'cabin', 'cable', 'cactus', 'camel', 'candy', 'canoe',
  'canyon', 'cargo', 'carpet', 'carrot', 'castle', 'cedar', 'chalk', 'charm',
  'cheese', 'cherry', 'chess', 'chill', 'choir', 'cider', 'cigar', 'circus',
  'clam', 'clay', 'cliff', 'clock', 'cloud', 'clover', 'coach', 'coast',
  'cobra', 'cocoa', 'comet', 'coral', 'corn', 'cotton', 'crane', 'crayon',
  'creek', 'crown', 'crumb', 'daisy', 'dance', 'date', 'delta', 'denim',
  'desert', 'diary', 'diner', 'dingo', 'doll', 'dolphin', 'dragon', 'dream',
  'drift', 'drum', 'duck', 'eagle', 'earth', 'echo', 'elbow', 'elder',
  'ember', 'emerald', 'engine', 'fable', 'falcon', 'farm', 'feast', 'fern',
  'ferry', 'field', 'finch', 'flame', 'flint', 'float', 'flute', 'foam',
  'forest', 'fossil', 'fox', 'frost', 'fruit', 'galaxy', 'garden', 'garlic',
  'gecko', 'giant', 'ginger', 'glacier', 'glove', 'goat', 'gold', 'grape',
  'grass', 'gravel', 'grove', 'guitar', 'habit', 'hammer', 'harbor', 'hazel',
  'heron', 'hill', 'honey', 'horse', 'hotel', 'humor', 'icing', 'igloo',
  'iguana', 'inch', 'iris', 'island', 'ivory', 'jacket', 'jade', 'jelly',
  'jewel', 'jungle', 'kayak', 'kettle', 'kiwi', 'koala', 'ladder', 'lake',
  'lamp', 'lantern', 'lemon', 'lily', 'lime', 'llama', 'lotus', 'lucky',
  'lunar', 'magic', 'mango', 'maple', 'marble', 'meadow', 'melon', 'mint',
  'mirror', 'mocha', 'moose', 'moss', 'mouse', 'nacho', 'navy', 'nectar',
  'nest', 'noble', 'north', 'nutmeg', 'oasis', 'ocean', 'olive', 'onion',
  'opal', 'orange', 'orbit', 'otter', 'oxygen', 'paddle', 'panda', 'paper',
  'parrot', 'peach', 'pearl', 'pebble', 'pepper', 'piano', 'pilot', 'pine',
  'pizza', 'planet', 'plum', 'polar', 'pond', 'poppy', 'prairie', 'pumpkin',
  'quail', 'quartz', 'quilt', 'rabbit', 'radar', 'raven', 'reef', 'ribbon',
  'river', 'robin', 'rocket', 'rose', 'ruby', 'saddle', 'sage', 'salsa',
  'sand', 'scarf', 'seal', 'shell', 'silver', 'sketch', 'sky', 'smile',
];

/** A readable password such as "maple-river-copper-cloud-panda-42": about 47 bits, long enough for the 15-character rule. */
export function passphrase(random: (length: number) => Uint8Array = length => crypto.getRandomValues(new Uint8Array(length))): string {
  const bytes = random(6);
  const words = Array.from(bytes.slice(0, 5), byte => WORDS[byte]);
  return `${words.join('-')}-${String(bytes[5] % 100).padStart(2, '0')}`;
}
