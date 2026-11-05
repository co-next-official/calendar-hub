import { redirect } from "next/navigation";
import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";

export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await getChatGPTUser();
  if (!user) redirect(chatGPTSignInPath("/"));
  redirect("/calendar.html");
}
