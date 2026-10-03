import type { CSSProperties } from "react";

/** A shimmering block standing in for something that has not arrived yet (only the very first time; after that the last answer is shown). */
export const Skel = ({ w, h, className = "", style }: { w?: string; h?: string; className?: string; style?: CSSProperties }) => <span className={`skel ${className}`.trim()} style={{ width: w, height: h, ...style }} />;

const round: CSSProperties = { borderRadius: 999 };

/** The server table before the list has loaded: the same columns and row height as the real one, so nothing jumps when it fills in. */
export function ServersSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="table-wrap" role="status" aria-label="Loading servers">
      <table className="servers">
        <thead>
          <tr>
            <th>Server</th>
            <th>Status</th>
            <th>Address</th>
            <th className="col-ports">Ports</th>
            <th>Access</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i} className="skeleton">
              <td data-label="Server">
                <div className="server-cell">
                  <Skel w="44px" h="44px" style={{ borderRadius: 12, flex: "none" }} />
                  <div className="skel-stack">
                    <Skel w="6.5rem" h="1rem" />
                    <Skel w="4.5rem" h="0.8rem" />
                  </div>
                </div>
              </td>
              <td data-label="Status">
                <div className="skel-stack">
                  <Skel w="5.5rem" h="1.6rem" style={round} />
                  <Skel w="7rem" h="0.8rem" />
                  <Skel w="8rem" h="0.8rem" />
                </div>
              </td>
              <td data-label="Address">
                <div className="skel-stack">
                  <Skel w="10rem" h="1rem" />
                  <Skel w="4.5rem" h="1.7rem" />
                </div>
              </td>
              <td data-label="Ports" className="col-ports">
                <Skel w="4.5rem" h="1.7rem" />
              </td>
              <td data-label="Access">
                <div className="skel-stack">
                  <Skel w="4.5rem" h="1.6rem" style={round} />
                  <Skel w="5.5rem" h="0.8rem" />
                </div>
              </td>
              <td className="col-actions">
                <Skel w="9rem" h="2.2rem" style={round} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The Network health column before it has loaded, in the same place so the page does not shift. */
export function NetworkSkeleton() {
  return (
    <aside className="network" aria-label="Network health" aria-busy="true">
      <div className="net-head">
        <h2>
          <span className="net-mark" />
          Network health
        </h2>
      </div>
      <ul className="health">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="health-item">
            <Skel w="28px" h="28px" style={{ borderRadius: "50%" }} />
            <div className="skel-stack">
              <Skel w="7rem" h="1rem" />
              <Skel w="90%" h="0.8rem" />
              <Skel w="5rem" h="0.8rem" />
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** Template cards before the list has loaded: the same fixed-size cards in the same grid. */
export function TemplateSkeletons({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="template-card skeleton" aria-hidden="true">
          <span className="card-banner skel" style={{ borderRadius: 0 }} />
          <span className="card-foot">
            <span className="card-text">
              <Skel w="7rem" h="1rem" />
              <Skel w="5.5rem" h="0.8rem" />
            </span>
            <Skel w="30px" h="30px" style={{ borderRadius: "50%", flex: "none" }} />
          </span>
        </div>
      ))}
    </>
  );
}

/** The backup groups before the list has loaded. */
export function BackupsSkeleton() {
  return (
    <div className="backup-groups" role="status" aria-label="Loading backups">
      {[0, 1].map((g) => (
        <section key={g} className="backup-group">
          <div className="backup-group-head">
            <div className="server-cell">
              <Skel w="44px" h="44px" style={{ borderRadius: 12, flex: "none" }} />
              <div className="skel-stack">
                <Skel w="8rem" h="1rem" />
                <Skel w="14rem" h="0.8rem" />
              </div>
            </div>
            <Skel w="9rem" h="2.2rem" style={round} />
          </div>
          <ul className="backup-list">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <div className="skel-stack">
                  <Skel w="16rem" h="0.9rem" />
                  <Skel w="9rem" h="0.75rem" />
                </div>
                <Skel w="8rem" h="2rem" style={round} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
