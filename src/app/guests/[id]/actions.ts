"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { enrichGuest } from "@/lib/enrich";

export async function refreshGuest(f: FormData) {
  const id = String(f.get("id") ?? "");
  const g = (await db().execute({ sql: "select id, canonical_name name, company, role from guests where id = ?", args: [id] })).rows[0];
  if (!g) return;
  await enrichGuest({ id, name: String(g.name), company: g.company as string | null, role: g.role as string | null }, { force: true });
  revalidatePath(`/guests/${id}`);
}
