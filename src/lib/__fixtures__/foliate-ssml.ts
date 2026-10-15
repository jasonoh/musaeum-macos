// Real output of foliate-js's TTS engine (vendor/foliate-js/tts.js), captured from the running app.
// Source: Darwin's Devices (John Long, Basic Books), imported into an isolated instance; captured 2026-10-15 over CDP with view.initTTS('sentence') then view.tts.start()/next().
// Each constant is the verbatim string start()/next() returned for one block, except where marked
// HAND-EDITED: this book carries no em/strong, xml:lang, ph or alias attributes, so those blocks are
// a captured block with the one construct foliate would emit spliced in.

/** OEBPS/darwinsdevices_ch01.html (chapter 1), a heading: one mark, text ends in a newline. */
export const BLOCK_HEADING =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>WHY ROBOTS?\n</speak>'

/** Chapter 1 (darwinsdevices_ch01.html), a six-sentence paragraph: marks 0..N before each sentence, trailing newline. */
export const BLOCK_PARAGRAPH =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>What’s the problem? <mark name="1"/>First and foremost, biologists do not study robots. <mark name="2"/>They work on organisms—living things, their environments, and their evolutionary history. <mark name="3"/>They use machines as tools to ascend a rainforest canopy, as instruments to measure biomechanical properties, as modes of transportation to collect fish from a coral reef. <mark name="4"/>As my friend had stated so succinctly, machines in general, and robots in particular, have nothing to do with biology—from his point of view. <mark name="5"/>Not from mine.\n</speak>'

/** Title page, section 2: a sentence, then a trailing mark with nothing after it but a newline. */
export const BLOCK_TRAILING_EMPTY_MARK =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>JOHN LONG\n<mark name="1"/>\n</speak>'

/** Title page, section 2: <break/> (a <br>) between lines, then two trailing empty marks. */
export const BLOCK_BREAKS =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>BASIC BOOK<break/>A Member of the Perseus Books Group<break/>New York\n<mark name="1"/>\n<mark name="2"/>\n</speak>'

/** Copyright page: a mark lands mid-line after an abbreviation ("John H. " / "Long, Jr."). */
export const BLOCK_ABBREVIATION_SPLIT =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>Copyright © 2012 by John H. <mark name="1"/>Long, Jr.\n</speak>'

/** Section 12 (chapter 7) caption: the text contains a literal ampersand, serialized as &amp;. */
export const BLOCK_AMPERSAND =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>FIGURE 7.4. <mark name="1"/>Robot Madeleine, a four-flippered Evolutionary Trekker. <mark name="2"/>Madeleine helped launch a new scientific journal, Bioinspiration &amp; Biomimetics, in 2006. <mark name="3"/>Madeleine is designed to represent aquatic tetrapods, descendents of the four-footed vertebrates that evolved on land and then evolved back to the water (see Figure 7.7). <mark name="4"/>By varying the pattern of how she uses her flippers, we can test the hypothesis that four flippers, compared to two, produced swimming behavior with faster top speeds, quicker acceleration, and better braking. <mark name="5"/>The cover image is used with permission of the Institute of Physics. <mark name="6"/>I took the picture of Madeleine while she was going through her first shake-down cruise in the outdoor pool of my friend John Keller.\n<mark name="7"/>\n</speak>'

/** Section 15 (notes): the text contains a literal less-than, serialized as &lt;. */
export const BLOCK_LESS_THAN =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>13. <mark name="1"/>In statistics-ese these least-squares linear regressions are all “highly significant,” with p &lt; 0.01 in each case. <mark name="2"/>Prior to testing, all data were transformed so that they fit a normal distribution. <mark name="3"/>The 20 percent refers to the “coefficient of determination,” also called the “r-squared value,” a number from 0 to 1 that indicates how well the best-fit line represents the relationship between the dependent and independent variables.\n</speak>'

/** The cover section: foliate's start() returned undefined (an image and no text). */
export const BLOCK_IMAGE_ONLY: string | undefined = undefined

// HAND-EDITED copies of BLOCK_HEADING / BLOCK_PARAGRAPH shapes. The element names are the ones
// fragmentToSSML builds (emphasis for em/strong, lang for a lang attribute, phoneme for ph).

/** HAND-EDITED: an <em> inside a sentence, as foliate emits it. */
export const BLOCK_EMPHASIS =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>It was a <emphasis>very</emphasis> long way.\n<mark name="1"/>Then <emphasis>we</emphasis> left.\n</speak>'

/** HAND-EDITED: a span carrying xml:lang. */
export const BLOCK_LANG =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>He said <lang xml:lang="fr">bonjour</lang> and left.\n</speak>'

/** HAND-EDITED: a book-carried ph attribute becomes a phoneme element wrapping the written word. */
export const BLOCK_PHONEME =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>Say <phoneme alphabet="ipa" ph="ˈmjuːzeɪəm">Musaeum</phoneme> twice.\n</speak>'

/** HAND-EDITED: a sub element with an alias; the written text, not the alias, is what the block carries. */
export const BLOCK_SUB =
  '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en"><mark name="0"/>Meet <sub alias="doctor">Dr.</sub> Long.\n</speak>'

/** HAND-EDITED: marks with only whitespace after them, and a prolog. */
export const BLOCK_WHITESPACE_ONLY =
  '<?xml version="1.0" encoding="UTF-8"?><speak xmlns="http://www.w3.org/2001/10/synthesis"><mark name="0"/>  \n <mark name="1"/>\n</speak>'
