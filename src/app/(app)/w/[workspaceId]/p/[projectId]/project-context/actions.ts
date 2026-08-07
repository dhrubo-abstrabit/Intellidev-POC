"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function updateProjectContext(
  workspaceId: string,
  projectId: string,
  description: string,
): Promise<{ message: string }> {
  await requireUser();

  // projects grants full update to any workspace member (no column
  // restriction, unlike action_items) — user-scoped client is sufficient.
  const supabase = await createClient();
  const { error } = await supabase
    .from("projects")
    .update({ description: description.trim() || null })
    .eq("id", projectId)
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`Could not save project context: ${error.message}`);
  }

  revalidatePath(`/w/${workspaceId}/p/${projectId}/project-context`);
  return { message: "Project context saved" };
}

const MAX_EXTRACT_FILE_BYTES = 10 * 1024 * 1024; // 10MB — generous for a text document, not a media file

/**
 * Extracts plain text from a PDF or .docx file so the client can drop it
 * into the textarea — same as the plain-text browse/drag-drop path, just
 * for formats FileReader.readAsText() can't meaningfully parse on its own.
 * Stateless: nothing is stored, no workspace/project scoping needed beyond
 * "must be signed in".
 */
export async function extractFileText(formData: FormData): Promise<{ text: string }> {
  await requireUser();

  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("No file provided.");
  }
  if (file.size > MAX_EXTRACT_FILE_BYTES) {
    throw new Error(`${file.name} is too large (max 10MB).`);
  }

  const name = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { text: result.text };
    } finally {
      await parser.destroy();
    }
  }

  if (
    name.endsWith(".docx") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  }

  throw new Error(`${file.name}: unsupported file type.`);
}
