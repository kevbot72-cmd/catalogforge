import { ImagePlus, Trash2 } from "lucide-react";
import { BufferedInput } from "../components/fields";
import { Button, Field } from "../components/ui";
import { avatarFromBytes, initials } from "../lib/profile";
import { useApp } from "../store/app";

/** Settings → Your details: name, nickname, business name and picture (shown on the welcome screen). */
export function UserSettings() {
  const { user, setUser, backend, toast } = useApp();
  const upload = async () => {
    const [f] = await backend.pickFiles({ multiple: false, extensions: ["jpg", "jpeg", "png", "webp", "gif"] });
    if (!f) return;
    try {
      setUser({ avatar: await avatarFromBytes(await backend.readFile(f.path)) });
    } catch (e) {
      toast({ tone: "error", title: "Couldn't read that picture", body: String(e) });
    }
  };
  return (
    <section data-testid="user-details">
      <h2 className="mb-3 text-sm font-semibold">Your details</h2>
      <div className="flex gap-6 rounded-lg border border-line bg-panel p-4">
        <div className="flex w-28 shrink-0 flex-col items-center gap-2">
          {user.avatar ? (
            <img src={user.avatar} alt="Your picture" className="h-24 w-24 rounded-full object-cover ring-2 ring-accent/30" data-testid="user-avatar" />
          ) : (
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-accent/10 text-2xl font-semibold text-accent">{initials(user) || "?"}</div>
          )}
          <Button size="sm" icon={<ImagePlus size={13} />} onClick={upload} data-testid="user-avatar-upload">{user.avatar ? "Change" : "Upload"}</Button>
          {user.avatar && <Button size="sm" variant="close" icon={<Trash2 size={12} />} onClick={() => setUser({ avatar: "" })}>Remove</Button>}
        </div>
        <div className="grid flex-1 grid-cols-2 gap-4">
          <Field label="Name"><BufferedInput value={user.name} onCommit={(name) => setUser({ name })} placeholder="e.g. Kevin Smith" data-testid="user-name" /></Field>
          <Field label="Alias / nickname" hint="Used on the welcome screen when set."><BufferedInput value={user.alias} onCommit={(alias) => setUser({ alias })} placeholder="e.g. Kev" data-testid="user-alias" /></Field>
          <Field label="E-commerce store name" className="col-span-2" hint="Your business name, shown on the welcome screen."><BufferedInput value={user.storeName} onCommit={(storeName) => setUser({ storeName })} placeholder="e.g. BluMoonDesign" data-testid="user-store-name" /></Field>
        </div>
      </div>
    </section>
  );
}
