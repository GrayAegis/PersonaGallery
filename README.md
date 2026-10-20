# Persona Gallery

Give each SillyTavern persona a set of images instead of a single avatar, and switch between
them from inside SillyTavern.

## What it does

A persona in SillyTavern is identified by its avatar file, so a persona can only ever have one
picture. This extension keeps a folder of images per persona and copies the one you pick over
that avatar file. The persona keeps its name, description, lorebook links, chat locks and
character connections, because none of those are stored in the image.

## Using it

Open **Persona Management**. Next to the existing persona buttons there is a new
picture-stack button.

- **Click** it to open the gallery for the current persona.
- **Shift-click** it to jump straight to the next image.

There is also a picture-stack button beside the message box, next to Quick Persona if you use
it, so you can switch without leaving the chat.

- **Click** it for a small menu of the current persona's images. Pick one and it applies
  immediately; the one in use is outlined in gold. The last entry opens the full gallery.
- **Shift-click** it to jump straight to the next image.
- Escape or a click anywhere else closes the menu.

Inside the gallery:

- Click a tile to make that image the persona's avatar. The current one is outlined in gold.
- **Add images** opens a file picker, or you can drop image files onto the window.
- Each image is labelled with the file name it arrived under. The tag icon changes that label,
  and the label is what the slash commands match on.
- The bin icon removes the image from the gallery folder without touching the persona.
- The lines icon beside each label opens that image's description, which you can write yourself
  or have a vision model write. See [Image descriptions](#image-descriptions).
- Drag a tile to move it. See [Arranging images](#arranging-images).
- The export and import buttons at the top right save the whole gallery as one file and read
  one back. See [Exporting and importing](#exporting-and-importing).

The first time you open a gallery for a persona, the avatar it already has is copied in as
`Original`, so switching away from it is reversible. Any picture you later set with
SillyTavern's own Change Persona Image button is captured into the gallery too, so a switch
can never discard it. Turn the first-time copy off under **Extensions → Persona Gallery** if
you would rather start empty.

## Pinning an image

The row under the grid pins whichever image is currently applied, in the same three scopes
SillyTavern uses for personas themselves.

| Pin | Effect |
| --- | --- |
| Default | Use this image whenever no other rule applies |
| Character | Use this image while this character or group is open |
| Chat | Use this image while this chat is open |

The most specific rule wins, so a chat pin beats a character pin, which beats the default.
Pins are re-evaluated when you open a chat and when you change persona, so wandering off to
another image by hand lasts only until the next chat load. Character pins and the default are
stored per persona; chat pins live in that chat's metadata and travel with the chat file, one
per persona, so switching personas inside a chat does not lose the other one's pin.

Buttons are dimmed when they cannot be used, which means no image is applied yet, or there is
no character or chat open to pin to.

Everything in the gallery can be reached from the keyboard: Tab moves between tiles, their
description, label and delete controls, and the pin buttons; Enter or Space activates whichever is focused.

## Arranging images

Drag a tile to where you want it. On a touch screen, drag it by its number badge instead, so
that swiping still scrolls the gallery. From the keyboard, focus a tile and press Ctrl with the
left or right arrow.

The order you set is kept per persona, and everything that goes through the gallery follows it:
the chat bar menu, Shift-click cycling, the numbers `/persona-image` takes, and which images go
first when the whole gallery is sent to the model. Images added afterwards go at the end, or at
the start if the gallery order setting is newest first. **Back to date order**, under the image
count, forgets the arrangement.

## Exporting and importing

The export button at the top right of the gallery saves the persona's whole gallery as one
`.json` file. It holds every image along with its label and description, the order, and the
default and character pins. Use it to back a persona up, or to move it to another SillyTavern.
Chat pins, and the image each of your messages keeps, are stored in the chat files and travel
with those instead.

The import button reads such a file into the persona whose gallery is open, after asking first.
Images keep their file names, so messages in moved chats find their images again. The exception
is a name already used in this gallery by a different picture, in which case the incoming one is
renamed. An image already here under the same name, byte for byte, is not added twice, so
importing the same file again only refreshes labels and descriptions. Pins from the file only
fill in what this gallery has not set itself, and the avatar is left as it is until you click an
image.

When you move a persona, opening its gallery on the new install may first copy its current avatar
in as `Original`. That picture usually arrives again with the import under its own name, so
delete whichever copy you don't need.

## Message images

Each message you send keeps showing the image your persona had when you sent it, so switching
to another image later does not change the picture beside your earlier messages. The choice is
stored in the message itself and travels with the chat file, including into branches.

Messages sent before this existed, or while the option was off, have nothing recorded and follow
the persona's current image. To give them their picture back, open a message's actions menu
(the **...** button) and click the images icon. Pick the image that message should show. Tick
**Also use it for the earlier messages with no image set** to fill in the whole stretch above it
in one go: it works back through your earlier messages and stops at the first one that already
has an image. So for a chat where the persona changed outfit halfway, pick the first outfit on
the last message before the change, then the second outfit on the latest message, both with
the box ticked. **Follow the current image** turns a message back to following the persona.

Clicking a message's avatar zooms into the image that message keeps. If a recorded image is
deleted from the gallery, its messages fall back to the persona's current avatar. Turn the
whole thing off with **Messages keep the image they were sent with** under
**Extensions → Persona Gallery**. Nothing recorded is lost, and it shows again when you turn
it back on.

## Slash commands

| Command | Effect |
| --- | --- |
| `/persona-gallery` | Opens the gallery for the current persona |
| `/persona-image` | Lists the current persona's images |
| `/persona-image next` | Switches to the next image |
| `/persona-image prev` | Switches to the previous image |
| `/persona-image Winter coat` | Switches by label, or by file name |
| `/persona-image 2` | Switches by position in the list |

They all act on the currently selected persona.

## Sending images to the model

A vision-capable model can be shown what your persona looks like, rather than only told.
Under **Extensions → Persona Gallery**, set **Send images to the model** to either the image
currently applied or the whole gallery, and pick a cap for how many the whole gallery sends.

Each image is shrunk to fit within the longest-edge limit in the settings, 1024 pixels by
default, re-encoded as JPEG, and attached to your most recent message, preceded by a short line
naming the persona and the image's gallery label. That label is the place to put a hint you
want the model to act on. A smaller edge means fewer tokens per image; a larger one keeps more
detail.

Two things to keep in mind. This needs a Chat Completion API, and nothing is sent on text
completion backends. The images ride along with every request, so sending the whole gallery on
a long chat is a real and repeated token cost.

Background calls made by other extensions, such as summarisers, expression classifiers and
captioners, do not get the images. Only the generations you trigger yourself carry them.

To check what actually goes out, turn on Prompt Inspector from the wand menu and look for
`image_url` entries on your last message. Persona Gallery puts itself first in the queue of
things that touch a finished prompt, so the inspector sees the images rather than the prompt as
it stood beforehand. The browser console also logs a line for each request saying how many
reference images were attached.

## Image descriptions

Each image can carry a written description of what it shows, which text-only models can use in
place of the picture.

### Writing a description

Every image in the gallery has a lines icon at the right of its label. Click it to open that
image's description. Type your own and **Save**, or click **Describe with vision model** to have
one written and then correct anything it got wrong. Once a description exists the icon is lit,
and clicking it opens the stored text for reading or editing. **Describe again** replaces it with
a fresh one from the vision model, and saving an empty box clears it. The window says whether the
text was written by hand or by a model, and when.

The vision model is the one set in **Extensions → Image Captioning**. Set its **Source** to
**Multimodal** and choose an API and model there. Persona Gallery will not ask it for anything
until you do, because that extension otherwise sits on defaults nobody chose. Writing by hand
needs none of this. The **Description prompt** setting is what the vision model is asked; leave
it empty for a prompt that asks for build, face, hair, eyes, skin, clothing and anything notable,
in plain prose. Once a vision model is set up, **Describe all** at the top of the gallery fills in
every image that has no description yet.

### Replacing the persona description

An image's description can stand in for the whole persona description, for a transformation, a
different identity, or anything else that changes more than an outfit. Open the image's
description, tick **Replace persona description**, write the full persona description that should
apply while that image is in use, and save. The image's icon turns into theatre masks.

While that image is applied, its text *is* the persona's description. Persona Management shows it,
and every preset, `{{persona}}` macro and persona prompt position uses it, so nothing in the
prompt needs changing. The persona's own description is set aside in the gallery's settings, and
comes back as soon as you switch to an image without the box ticked, or delete the image. Moving
from one replacing image to another swaps the text without losing the original. Chat and
character pins switch images, and so switch descriptions, as well.

If you edit the description in Persona Management while an image's text is standing in, the edit
is saved to that image, since that is the text you were looking at. The gallery shows a note while
an image's text is in use. Replacing text is not also sent through `{{galleryLook}}` or in place
of the image, because it is already in the prompt as the persona description.

Switch back to an ordinary image before removing the extension, or the persona keeps the
replacing text.

### Sending descriptions with `{{galleryLook}}`

Write `{{galleryLook}}` where you want the description to go. The usual place is the end of the
persona's description in Persona Management, so the text goes wherever your preset puts your
persona:

```
{{user}} is a courier who works the night routes.

{{galleryLook}}
```

The macro renders the description of the image currently applied, in the form
`[Reference image of <persona>, <label>: <description>]`. With **Send images to the model** set
to the whole gallery, it renders every image being sent instead, up to the cap. It works whatever
that setting says, including **Do not send**: writing the macro is already the request. Images
without a description are left out, so with none described it renders nothing. If your preset
includes your persona description twice, the descriptions go out twice too.

Because the macro is plain text, it also works with Text Completion backends, which cannot carry
images. Background prompts that include your persona description carry it too.

### Sending descriptions instead of images

A text-only model can still be told what your persona looks like without you writing a word.
With sending on, tick **Describe images instead of sending them**. Any image being sent that has
no description is then described by the vision model, and the stored text goes out on every
request in place of the image. You pay for the image once rather than on every turn, and the
roleplay model needs no vision support. Descriptions you wrote yourself are used as they are.

Missing descriptions are written when a request starts, which makes that one request slower. Use
**Describe all** beforehand to avoid the wait. If an image cannot be described, it is left out of
that request rather than sent as an image, and a warning shows once per session. Token counts and
other dry runs use stored descriptions but never ask for new ones.

The text goes through `{{galleryLook}}` when the macro is in the prompt. Otherwise it is added to
your most recent message. That is the last thing the model reads, a loud place for a paragraph
about your persona's appearance, and some presets end the prompt with instructions meant to stay
last, so the macro is usually the better choice. Persona Gallery checks the finished prompt: if the
macro's text is not in it, because the macro is nowhere in the prompt or sits in a prompt that is
switched off, the descriptions go on your message instead. With Text Completion, descriptions are
only written ahead of time when the macro is in your persona description; if you put it anywhere
else, use **Describe all** first.

## Where things are stored

Images go in your user data folder under `user/images/persona-gallery-<avatar file name>/`.
You can drop files in there by hand and they show up in the gallery. Labels, descriptions and the
record of which image is active live in `settings.json` under
`extension_settings.personaGallery`, so they travel with a settings backup.

Deleting a persona in SillyTavern clears its labels and descriptions but leaves the image folder, so nothing is
lost by accident. Delete the folder yourself if you want the files gone.

## Things worth knowing

- SillyTavern converts avatars to PNG on upload, so an animated GIF becomes a still frame once
  applied. The original file stays in the gallery untouched.
- Avatars are not resized on upload unless you crop them, so the gallery copy and the applied
  avatar are the same resolution.
- Switching rewrites the persona's avatar file in place. Anything pointing at that file, such as
  the persona list, shows the new image. Your past messages do not, because each one keeps the
  image it was sent with (see [Message images](#message-images)).
- Switching updates the chat live, including themes that paint avatars as CSS backgrounds,
  such as Moonlit Echoes' Echo and Whisper styles. Browsers keep showing the old picture for an
  unchanged URL until the page reloads, so each switch stamps a new version onto every URL for
  that persona's avatar, including ones rendered or rewritten afterwards.
- Only one switch runs at a time. A second one that arrives while the first is still writing is
  ignored, and the slash command returns an empty string so a script can tell.

## Installing elsewhere

Copy this folder into `data/<your user>/extensions/`, or into
`public/scripts/extensions/third-party/` to make it available to every account on the server.
Reload SillyTavern afterwards.
