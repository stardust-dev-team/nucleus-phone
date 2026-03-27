import { useState } from 'react';

export default function ProductReference({ productReference }) {
  const [open, setOpen] = useState(false);

  if (!productReference?.length) return null;

  // Product reference can be an array of strings or objects
  const products = productReference.map(p => (typeof p === 'string' ? { name: p } : p));

  return (
    <div>
      <div
        className="flex justify-between items-center cursor-pointer"
        style={{ marginBottom: open ? 8 : 0 }}
        onClick={() => setOpen(!open)}
      >
        <div className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-wider">
          Recommended product
        </div>
        <span className="text-xs text-cp-text-muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div
          className="rounded-[10px] py-3.5 px-4 transition-colors duration-300 bg-cp-card border border-cp-border"
        >
          {products.map((product, i) => (
            <div key={i}>
              <div className="flex justify-between items-center mb-2.5">
                <span className="text-sm font-medium text-cp-text">{product.name}</span>
                {product.price && (
                  <span className="text-[15px] font-semibold" style={{ color: 'var(--cockpit-green-500)' }}>
                    {product.price}
                  </span>
                )}
              </div>
              {product.specs && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {Object.entries(product.specs).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-xs text-cp-text-muted capitalize">{k}</span>
                      <span className="text-xs font-medium text-cp-text">{v}</span>
                    </div>
                  ))}
                </div>
              )}
              {i < products.length - 1 && (
                <div className="my-2" style={{ borderBottom: '1px solid var(--cockpit-card-border)' }} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
