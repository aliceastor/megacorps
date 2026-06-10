import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Crosshair,
  FileClock,
  GitBranch,
  Kanban,
  MessageSquare,
  Network,
  Pause,
  Search,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { DesignDemoMouseMotion } from './mouse-motion';

const missions = [
  {
    id: 'MC-139',
    title: 'Kanban detail viewport correction',
    owner: 'Alice Astor',
    stage: 'Active',
    stageKey: 'active',
    signal: 'adapter_session_delta',
    cost: '$0.0078',
    risk: 'low',
  },
  {
    id: 'MC-145',
    title: 'External wait polling controls',
    owner: 'Ribel',
    stage: 'Review',
    stageKey: 'review',
    signal: 'manual wake available',
    cost: '$0.0000',
    risk: 'medium',
  },
  {
    id: 'MC-131',
    title: 'Message Board / Ticket Thread split',
    owner: 'Ribel',
    stage: 'Done',
    stageKey: 'done',
    signal: 'artifact accepted',
    cost: '$0.0042',
    risk: 'low',
  },
  {
    id: 'MC-117',
    title: 'Stage transition CancelError',
    owner: 'System',
    stage: 'Blocked',
    stageKey: 'blocked',
    signal: 'race condition suspected',
    cost: '$0.0019',
    risk: 'high',
  },
];

const events = [
  ['13:30', 'DISPATCH', 'Output received after card was already done; current stage preserved.'],
  ['13:29', 'WEBHOOK', 'Alice submitted artifact and closed execution loop.'],
  ['13:27', 'LOCK', 'Execution lock acquired via loop runner.'],
  ['13:26', 'STAGE', 'Task returned to todo for collaboration enforcement.'],
];

const agents: Array<[string, string, string, 'Idle' | 'Busy' | 'Offline']> = [
  ['Alice Astor', 'CEO', 'hermes-ssh', 'Idle'],
  ['Ribel', 'Product Operator', 'codex-app', 'Busy'],
  ['System Runner', 'Automation', 'mock', 'Offline'],
];

export default function DesignDemoPage() {
  return (
    <main className="mc-ref-shell">
      <DesignDemoMouseMotion />
      <div className="mc-ref-atmosphere" aria-hidden="true">
        <span className="mc-ref-halo halo-a" />
        <span className="mc-ref-halo halo-b" />
        <span className="mc-ref-halo halo-c" />
        <span className="mc-ref-scanline" />
      </div>

      <section className="mc-ref-window" aria-label="MegaCorps design demo">
        <aside className="mc-ref-rail" aria-label="Primary navigation">
          <div className="mc-ref-mark">MC</div>
          <nav>
            <a className="active" href="/design-demo" aria-label="Board"><Kanban size={18} /></a>
            <a href="/design-demo" aria-label="Agents"><Bot size={18} /></a>
            <a href="/design-demo" aria-label="Network"><Network size={18} /></a>
            <a href="/design-demo" aria-label="Messages"><MessageSquare size={18} /></a>
            <a href="/design-demo" aria-label="Logs"><FileClock size={18} /></a>
          </nav>
          <button aria-label="Review controls"><ShieldCheck size={18} /></button>
        </aside>

        <section className="mc-ref-main">
          <header className="mc-ref-topbar">
            <div>
              <p>MEGACORPS / OPERATIONS</p>
              <h1>Agent Mission Control</h1>
            </div>
            <label className="mc-ref-search">
              <Search size={17} />
              <input aria-label="Search" placeholder="Search task, agent, artifact" />
              <kbd>Ctrl K</kbd>
            </label>
            <button className="mc-ref-action">New Operation <ArrowUpRight size={16} /></button>
          </header>

          <section className="mc-ref-briefing">
            <div className="mc-ref-brief-copy">
              <span className="mc-ref-kicker"><Crosshair size={15} /> LIVE BOARD</span>
              <h2>Coordinate agent work like a mission plan.</h2>
              <p>
                Light, quiet workspace. Dark intelligence surfaces only where they improve focus:
                task state, context mode, external waits, and recovery.
              </p>
            </div>
            <div className="mc-ref-telemetry" aria-label="Telemetry summary">
              <div><span>Open</span><strong>06</strong></div>
              <div><span>Busy</span><strong>01</strong></div>
              <div><span>Cost</span><strong>$0.029</strong></div>
              <div><span>Resume</span><strong>96%</strong></div>
            </div>
          </section>

          <section className="mc-ref-grid">
            <section className="mc-ref-board" aria-label="Mission list">
              <header className="mc-ref-section-head">
                <div>
                  <p>Task Queue</p>
                  <h2>Current Operations</h2>
                </div>
                <div className="mc-ref-segment">
                  <button className="active">All</button>
                  <button>Active</button>
                  <button>Review</button>
                </div>
              </header>

              <div className="mc-ref-mission-list">
                {missions.map((mission) => (
                  <article className={`mc-ref-mission stage-${mission.stageKey} risk-${mission.risk}`} key={mission.id}>
                    <div className="mc-ref-mission-id">
                      <code>{mission.id}</code>
                      <span>{mission.stage}</span>
                    </div>
                    <div>
                      <h3>{mission.title}</h3>
                      <p>{mission.signal}</p>
                    </div>
                    <div className="mc-ref-mission-meta">
                      <span>{mission.owner}</span>
                      <strong>{mission.cost}</strong>
                    </div>
                    <ChevronRight size={18} />
                  </article>
                ))}
              </div>
            </section>

            <aside className="mc-ref-intel" aria-label="Selected task detail">
              <div className="mc-ref-map">
                <div className="mc-ref-map-grid" />
                <CircleDot className="node n1" size={18} />
                <CircleDot className="node n2" size={18} />
                <CircleDot className="node n3" size={18} />
                <div className="route r1" />
                <div className="route r2" />
              </div>

              <div className="mc-ref-intel-copy">
                <p>SELECTED TASK</p>
                <h2>Kanban detail viewport correction</h2>
                <dl>
                  <div><dt>Assignee</dt><dd>Alice Astor</dd></div>
                  <div><dt>Runtime</dt><dd>hermes-ssh</dd></div>
                  <div><dt>Context</dt><dd>adapter delta</dd></div>
                  <div><dt>Review Gate</dt><dd>Ribel</dd></div>
                </dl>
              </div>

              <div className="mc-ref-button-row">
                <button><Activity size={16} /> Run</button>
                <button><ShieldCheck size={16} /> Review</button>
                <button className="danger"><TriangleAlert size={16} /> Hold</button>
              </div>
            </aside>
          </section>

          <section className="mc-ref-bottom">
            <div className="mc-ref-panel">
              <header>
                <div>
                  <p>Agents</p>
                  <h2>Team Signal</h2>
                </div>
                <GitBranch size={18} />
              </header>
              <div className="mc-ref-agent-list">
                {agents.map(([name, role, runtime, state]) => (
                  <div className="mc-ref-agent" key={name}>
                    <span className={`light ${state.toLowerCase()}`} />
                    <div>
                      <strong>{name}</strong>
                      <p>{role}</p>
                    </div>
                    <code>{runtime} | {state}</code>
                  </div>
                ))}
              </div>
            </div>

            <div className="mc-ref-panel">
              <header>
                <div>
                  <p>Ticket Thread</p>
                  <h2>Recent Events</h2>
                </div>
                <Clock3 size={18} />
              </header>
              <ol className="mc-ref-events">
                {events.map(([time, kind, text]) => (
                  <li key={`${time}-${kind}`}>
                    <code>{time}</code>
                    <span>{kind}</span>
                    <p>{text}</p>
                  </li>
                ))}
              </ol>
            </div>

            <div className="mc-ref-panel mc-ref-checks">
              <header>
                <div>
                  <p>Context</p>
                  <h2>Prompt Safety</h2>
                </div>
                <Pause size={18} />
              </header>
              <p><Check size={15} /> Full bootstrap avoided after first run.</p>
              <p><Check size={15} /> Parent chain and dependency state included.</p>
              <p><Check size={15} /> External wait interval controlled by agent.</p>
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}
