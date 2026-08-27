import { generateImage, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { WorkspaceEvent } from '@workspace/protocol'
import type { ModelGateway } from '@workspace/gateway-model'
import type { Workspace } from '@workspace/workspace'

/**
 * Making pictures.
 *
 * Runs through the same gateway as everything else, so the same rules apply:
 * the org's key, the org's bill, our meter. An image model reached directly
 * from a tool would be a hole in exactly the arrangement §5 and §13 exist to
 * protect.
 *
 * The result is written to the workspace and the tool returns a PATH. Handing
 * base64 back to the model would put a megabyte of it into conversation
 * history, where it would be re-serialised every turn and re-sent on every
 * request — for a picture the model has already seen and does not need again.
 * The artifact pane reads the file.
 */

export interface ImageToolOptions {
  workspace: Workspace
  gateway: ModelGateway
  emit: (event: WorkspaceEvent) => void
  /** An OpenRouter image model ID. */
  model?: string
  /** Directory for generated images, so they are findable and deletable. */
  directory?: string
}

export const DEFAULT_IMAGE_MODEL = 'google/gemini-3-pro-image'

export function buildImageTools(options: ImageToolOptions): ToolSet {
  const directory = options.directory ?? '/images'
  const modelId = options.model ?? DEFAULT_IMAGE_MODEL

  return {
    generateImage: tool({
      description:
        'Generate an image from a text description and save it to the workspace. Returns the ' +
        'path. Use this for diagrams, illustrations, mockups or any picture the user asks for. ' +
        'Describe what should be IN the image, not what you want done — "a cutaway diagram of a ' +
        'turbofan, labelled, on white" rather than "draw me an engine".',
      inputSchema: z.object({
        prompt: z.string().describe('What the image should show'),
        filename: z
          .string()
          .optional()
          .describe('Base name without extension, e.g. "turbofan-cutaway"'),
        aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).default('1:1'),
      }),
      execute: async ({ prompt, filename, aspectRatio }) => {
        // Checked before the call, like every other spend: an image is not
        // cheap, and a ceiling that only covers text is not a ceiling.
        try {
          options.gateway.budget.assertCanProceed()
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) }
        }

        try {
          const result = await generateImage({
            model: options.gateway.imageModel(modelId),
            prompt,
            aspectRatio,
            n: 1,
          })

          const image = result.images[0] ?? result.image
          if (!image) return { ok: false, reason: 'The model returned no image.' }

          const extension = extensionFor(image.mediaType ?? 'image/png')
          const path = `${directory}/${slug(filename ?? prompt)}.${extension}`
          await options.workspace.write(path, image.uint8Array)

          options.emit({
            type: 'workspace.file.changed',
            runId: 'ui',
            ts: Date.now(),
            path,
            op: 'created',
          })

          return {
            ok: true,
            path,
            mediaType: image.mediaType ?? 'image/png',
            bytes: image.uint8Array.byteLength,
            // Said explicitly because a model that has just generated an image
            // will otherwise try to describe it back into the conversation.
            note: 'Saved. Refer to it by path; it is shown to the user automatically.',
          }
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) }
        }
      },
    }),
  }
}

function extensionFor(mediaType: string): string {
  if (mediaType.includes('jpeg') || mediaType.includes('jpg')) return 'jpg'
  if (mediaType.includes('webp')) return 'webp'
  return 'png'
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'image'
  )
}
