export interface LyricPreset {
  id: string;
  title: string;
  artist: string;
  genre: string;
  lineCount: number;
  text: string;
}

export const SAMPLE_LYRICS_PRESETS: LyricPreset[] = [
  {
    id: 'user-22-lines',
    title: 'Midnight Echoes (22 Lines)',
    artist: 'Acoustic Wave',
    genre: 'Indie Pop',
    lineCount: 22,
    text: `Walking through the quiet street tonight
The city lights are glowing softly blue
I hear the echoes fading out of sight
And every shadow whispers back to you

The clock is ticking on the bedroom wall
A gentle breeze is knocking at the door
I wait to see if you will softly call
Like all the summer days we had before

Through the rain and through the neon haze
We were dancing in the midnight glow
Counting down the fleeting golden days
Wondering which way the winds would blow

Hold my hand until the morning breaks
Wash away the sorrow from our mind
Take a chance on all the steps it takes
Leaving all our yesterday behind

Stars are shining clear above the hill
Every moment frozen in the air
When the world around is standing still
You will always find me waiting there`
  },
  {
    id: 'synthwave-12',
    title: 'Neon Horizon (12 Lines)',
    artist: 'Cyber Sunset',
    genre: 'Synthwave',
    lineCount: 12,
    text: `Cruising down the highway in the dark
Neon pink reflections on the glass
Chasing every fleeting electric spark
Watching all the digital towers pass

Synthwave rhythm pounding in my chest
Analog dreams that never fade away
Looking out across the ocean west
Searching for tomorrow in today

Turn the volume up and feel the groove
Laser beams across the velvet sky
Nothing in this universe can move
Faster than the way our spirits fly`
  },
  {
    id: 'short-demo-6',
    title: 'Vibe Code Anthem (6 Lines)',
    artist: 'AI Studio Band',
    genre: 'Acoustic',
    lineCount: 6,
    text: `Upload your favorite audio track
Paste your lyrics line by line
Click auto-align or tap the beat
Watch the timestamps fall in line
Export your brand new SRT file
Everything in perfect sync and style`
  }
];
