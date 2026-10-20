# Persona Gallery how-to

The [README](README.md) explains each feature on its own. This guide is about putting them
together: how `{{galleryLook}}` actually works, how to set up a persona with several looks, and
which tool to use when a persona takes on another identity or turns into something else.

## How `{{galleryLook}}` works

`{{galleryLook}}` is a placeholder. You write it once in the persona description, and it is
filled in fresh every time a prompt is built, from whichever image is applied at that moment.
Nothing about any particular image is ever saved into the persona description itself.

### What is stored where

| Thing | Where it lives | Changes by itself? |
| --- | --- | --- |
| The persona description | Persona Management, e.g. "… `{{galleryLook}}`" | No. The placeholder just sits there. |
| Each image's description | The gallery, one per image | Only when you edit it |
| Which image is applied | The gallery | When you switch images |

### What happens on every message

1. SillyTavern builds the prompt and reaches the persona description.
2. It finds `{{galleryLook}}` and asks Persona Gallery what to put there.
3. Persona Gallery looks at the applied image and returns its description, as
   `[Reference image of <persona>, <label>: <description>]`. An image with no description
   returns nothing.
4. That text goes into this one prompt. The persona description in Persona Management still
   says `{{galleryLook}}`.

So as you switch images, the persona part of the prompt changes like this:

| Applied image | What the model gets |
| --- | --- |
| One with a description | The persona description, plus that image's description in brackets |
| One without a description | The persona description, with nothing added |
| You switch to another | From the next prompt on, the new image's text, and none of the old one's |

Persona Management never shows the filled-in text. To see what actually went out, turn on
Prompt Inspector from the wand menu.

### Pictures are separate

The persona description never contains images. When **Send images to the model** is set to
send them, the picture itself is attached to your latest message, captioned
`[Reference image of <persona>, <label>]`. `{{galleryLook}}` only ever adds text, and it does so
whatever **Send images to the model** says, including **Do not send**.

### The one setting to get right

Keep **Send images to the model** on **The image currently applied** or **Do not send**. On
**The whole gallery**, step 3 returns the description of every image being sent at once, so
the notes for an alternate look would be in every prompt, even when that look isn't applied.

## Setting up a persona with several looks

### 1. Split the appearance

Put in the persona description only what is true in every image, and let each image's
description carry what changes.

| Persona description | Image descriptions |
| --- | --- |
| Name, personality, background, voice | Hair colour and style |
| Fixed traits: height, build, eye colour, face, scars | Clothing, accessories, props |
| `{{galleryLook}}`, on its own line | Anything else that differs between images |

For example:

```
<Name> is a <role> who <background>. <Personality>. <Fixed physical traits>.

{{galleryLook}}
```

The reason is contradiction rather than repetition. If the persona description says one
hairstyle and the applied image says another, the model gets two looks and may blend them or
pick the wrong one. Repeating fixed traits in both places is harmless. The vision model's
default prompt describes build, face and eye colour too, so some of that will happen anyway.

### 2. Describe every image you use

Click the lines icon on each image's label and either write the description or click
**Describe with vision model**. Do the image you use most as well. An image without a
description adds nothing, which leaves the model with only the fixed traits.

### 3. Pick the send setting for your model

- **A text-only model:** **Do not send**. `{{galleryLook}}` still sends the applied image's
  description, and nothing else is needed. The descriptions must cover appearance, since the
  model never sees a picture.
- **A vision model:** **The image currently applied**. The model sees the picture on your
  latest message and gets the description from the persona description. Since it can see the
  picture, the description can be shorter, or just notes. If you might switch to a text-only
  model later, keep at least a line of appearance in each one.

**Describe images instead of sending them** suits a text-only model when you'd rather the vision
model wrote the descriptions for you, the first time each image is used. With Chat Completion and
no `{{galleryLook}}` in the prompt, that mode adds the text to the end of your latest message
instead, which is the loudest place in the prompt for it. With the macro, it goes where the
macro is and nowhere else.

## Another identity on top of the persona

For an alias, a cover identity, an alter ego, or anything where the persona is still themself
underneath, put the identity in an ordinary image description. The persona description stays as
it is, and the image's text is added to it while that image is applied:

```
<Appearance in this look>. This is <alias>, <persona> going by another name. <Alias> is
<personality as the alias>. Nobody else knows <alias> is <persona>.
```

Label the image with the alias, so the line reads `[Reference image of <persona>, <alias>: …]`
and any picture you send carries the same name.

Things to watch:

- **Say who knows.** A line like "Nobody else knows" stops the narrator from having other
  characters see straight through it.
- **Appearance first, then identity.** The line is framed as a reference image, so it reads
  naturally as what they look like, then who they are like this.
- **Don't press Describe again** on that image once you've added notes by hand. It rewrites the
  whole text from the picture.
- **The whole gallery setting** would put this text in every prompt. See
  [the one setting to get right](#the-one-setting-to-get-right).

## Turning into something else

When the persona's own description stops being true, use **Replace persona description**
instead: a transformation, a curse, a body swap, a different person altogether. Tick it in the
image's description and write the complete persona description for that state, including
appearance.

While that image is applied, its text is the persona description: Persona Management shows it,
and every preset, `{{persona}}` macro and persona prompt position uses it. The original comes
back when you switch to an image without the box ticked. Edits made in Persona Management in the
meantime are saved to that image.

Two side effects to know about:

- `{{galleryLook}}` sends nothing for that image, since its text is already in the prompt as the
  persona description.
- Lorebook entries set to **Match Persona Description** search the replacing text while it's
  applied, not the original. An entry that should fire in every form needs its keyword in each
  replacing text. An attached persona lorebook itself stays attached either way.

### Which one to use

| | Ordinary description | Replace persona description |
| --- | --- | --- |
| Persona description | Kept, with the image's text added | Swapped out while applied |
| Model knows the persona underneath | Yes | Only what you write into the replacement |
| Good for | Aliases, cover identities, outfits, alter egos | Transformations, full changes of person |
| Text you maintain | The persona once, plus a short note per image | A full description per replacing image |

## Keeping each message's picture

With **Messages keep the image they were sent with** on, which is the default, each message you
send keeps the image that was applied when you sent it. Messages sent before that have nothing
recorded, so they follow whatever image is applied now.

To fix a chat where the look changed partway through:

1. Find your last message sent in the first look. Open its **...** menu, click the images icon,
   tick **Also use it for the earlier messages with no image set**, and pick the first look.
   Everything above it is filled in.
2. Do the same on your latest message with the second look. That fills the stretch in between,
   stopping where step 1 left off.

Repeat for each change of look, working down the chat.

## Moving a persona to another SillyTavern

1. In the old install, open the persona's gallery and click the export button. It saves one
   `.json` file with every image, its label and description, the order and the pins.
2. Move the persona and any chats you want to keep. The images messages keep are tied to the
   persona's avatar file name, so keep it the same, for example by copying the persona's file
   from `User Avatars`. If the persona ends up with a different file name, messages in moved
   chats lose the images they kept.
3. In the new install, open that persona's gallery and click the import button.

Opening a gallery for the first time may copy the persona's current avatar in as `Original`.
The same picture usually comes in again with the import under its own name, so delete
whichever copy you don't need.

## Checking what was sent

- **Prompt Inspector**, from the wand menu, shows the finished prompt. Look for
  `Reference image of` to find descriptions, and `image_url` entries on your latest message for
  pictures.
- **The browser console**, at its Verbose level, logs a `[Persona Gallery]` line whenever
  pictures or descriptions are attached to your latest message, and in describe mode when the
  descriptions went through `{{galleryLook}}` instead.
