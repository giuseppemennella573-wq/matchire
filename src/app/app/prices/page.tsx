import { requireVendor } from "@/lib/auth";
import { getItems } from "@/lib/engine";
import { fmtMoney, priceListMode } from "@/lib/pricing";
import { aiEnabled } from "@/lib/ai";
import type { Item } from "@/lib/types";
import { activateImportedAction, deleteItemAction, importPriceListAction, saveItemAction } from "../actions";
import { Submit } from "@/components/submit";

export const metadata = { title: "Price list" };

function priceText(i: Item) {
  const unit = i.pricing === "per_hour" ? "/hour" : i.pricing === "per_pax" ? "/pax" : i.included_hours ? ` for ${i.included_hours}h` : "";
  const extra = i.extra_hour_price ? ` · +${fmtMoney(i.extra_hour_price)}/extra hour` : "";
  const pax = i.min_pax ? ` · min ${i.min_pax} pax` : "";
  return `${fmtMoney(i.price)}${unit}${extra}${pax}`;
}

function ItemForm({ item, kind }: { item?: Item; kind?: "package" | "addon" }) {
  const k = item?.kind ?? kind ?? "package";
  return (
    <form action={saveItemAction} className="stack">
      {item && <input type="hidden" name="id" value={item.id} />}
      <div className="grid3">
        <label className="field"><span>Name</span><input name="name" required defaultValue={item?.name} /></label>
        <label className="field"><span>Type</span>
          <select name="kind" defaultValue={k}><option value="package">Package</option><option value="addon">Add-on</option></select>
        </label>
        <label className="field"><span>Charged</span>
          <select name="pricing" defaultValue={item?.pricing ?? "flat"}>
            <option value="flat">Flat price</option><option value="per_hour">Per hour</option><option value="per_pax">Per guest</option>
          </select>
        </label>
      </div>
      <label className="field"><span>What&apos;s included (Matchire uses this to answer questions)</span><input name="description" defaultValue={item?.description} /></label>
      <div className="grid3">
        <label className="field"><span>Price (SGD)</span><input name="price" type="number" step="0.01" min="0" required defaultValue={item?.price} /></label>
        <label className="field"><span>Hours included</span><input name="included_hours" type="number" step="0.5" min="0" defaultValue={item?.included_hours ?? ""} /></label>
        <label className="field"><span>Extra hour (SGD)</span><input name="extra_hour_price" type="number" step="0.01" min="0" defaultValue={item?.extra_hour_price ?? ""} /></label>
        <label className="field"><span>Min guests</span><input name="min_pax" type="number" min="0" defaultValue={item?.min_pax ?? ""} /></label>
        <label className="field"><span>Max guests</span><input name="max_pax" type="number" min="0" defaultValue={item?.max_pax ?? ""} /></label>
        <label className="check" style={{ alignSelf: "end", paddingBottom: 10 }}><input type="checkbox" name="active" defaultChecked={item ? !!item.active : true} /><span>Live: use in quotes</span></label>
      </div>
      <div className="row"><button className="btn btn-primary btn-sm" type="submit">{item ? "Save" : "Add"}</button></div>
    </form>
  );
}

/** The rate-card import, shared by the first-time card and the one at the bottom of the list. */
function ImportForm() {
  return (
    <form action={importPriceListAction} className="stack">
      <textarea name="text" rows={4} placeholder={"Classic booth 2h $450, extra hour $120\n360 booth 2h $650, extra hour $180\nCustom frame $80"} />
      <input type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" />
      <div><Submit pending="Reading your rate card…">Import</Submit></div>
    </form>
  );
}

export default async function Prices({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string; manual?: string }> }) {
  const { vendor } = await requireVendor();
  const { msg, error, manual } = await searchParams;
  const items = getItems(vendor.id);
  const pending = items.filter((i) => !i.active).length;
  const mode = priceListMode(items.length, aiEnabled(), !!manual);
  const empty = mode !== "list";

  const section = (kind: "package" | "addon", title: string, hint: string) => {
    const list = items.filter((i) => i.kind === kind);
    return (
      <section className="card card-flush">
        <div className="card-head"><div><h2>{title}</h2><p className="small muted">{hint}</p></div></div>
        {list.length === 0 && <p className="empty">None yet.</p>}
        {list.map((i) => (
          <details key={i.id} className="more" style={{ borderBottom: "1px solid var(--line)", padding: "12px 18px" }}>
            <summary style={{ color: "var(--ink)" }}>
              <span className="row between">
                <span className="row"><b>{i.name}</b>{!i.active && <span className="badge badge-amber">Not live</span>}</span>
                <span className="mono small">{priceText(i)}</span>
              </span>
              {i.description && <span className="small muted" style={{ fontWeight: 400 }}>{i.description}</span>}
            </summary>
            <div className="stack">
              <ItemForm item={i} />
              <form action={deleteItemAction}><input type="hidden" name="id" value={i.id} /><button className="btn btn-danger btn-sm" type="submit">Delete</button></form>
            </div>
          </details>
        ))}
        <details className="more" style={{ padding: "12px 18px" }} open={mode === "manual" && kind === "package"} id={kind === "package" ? "add-package" : undefined}>
          <summary>+ Add {kind === "package" ? "a package" : "an add-on"}</summary>
          <ItemForm kind={kind} />
        </details>
      </section>
    );
  };

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <h1>Price list</h1>
          <p className="muted">Matchire quotes only from what&apos;s here. It never invents a price.</p>
        </div>
        {!empty && <a className="btn btn-ghost btn-sm" href="#import">Import</a>}
      </div>
      {msg && <p className="alert alert-ok" role="status">{msg}</p>}
      {error && <p className="alert alert-err" role="alert">{error}</p>}
      {pending > 0 && (
        <div className="alert alert-warn row between">
          <span>{pending} item{pending > 1 ? "s aren't" : " isn't"} live yet. Check prices, then make them live.</span>
          <form action={activateImportedAction}><button className="btn btn-ghost btn-sm" type="submit">Make all live</button></form>
        </div>
      )}
      {mode === "import-first" ? (
        <>
          <section className="card stack import-first" id="import">
            <div className="stack" style={{ gap: 6 }}>
              <h2>Upload your rate card</h2>
              <p className="muted">PDF, photo, or paste the text. We&apos;ll turn it into packages you can edit. Nothing goes live until you approve it.</p>
            </div>
            <ImportForm />
          </section>
          <p className="small"><a href="/app/prices?manual=1#add-package">or add packages by hand</a></p>
        </>
      ) : (
        <>
          {empty && !aiEnabled() && <p className="small muted">Add your packages below. Importing a rate card needs AI, which is switched off on this server.</p>}
          {section("package", "Packages", "The main thing a planner books. Every quote starts with one.")}
          {section("addon", "Add-ons", "Extras added when a planner asks for them: frames, transport, staff, cleaning.")}
        </>
      )}

      {(mode === "list" || (mode === "manual" && aiEnabled())) && (
        <section className="card stack" id="import">
          <div className="stack" style={{ gap: 4 }}>
            <h2>Import a rate card</h2>
            <p className="small muted">Paste your price list, or upload a PDF or a photo of your rate card. Matchire sets up the items for you to check; nothing goes live until you approve it.</p>
          </div>
          {!aiEnabled() && <p className="alert alert-warn small">Importing needs AI, which is switched off on this server.</p>}
          <ImportForm />
        </section>
      )}
    </div>
  );
}
