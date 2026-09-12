import { useMemo, useState } from "react";

/**
 * 시계열 라인 차트 (인라인 SVG).
 *
 * 차트 라이브러리를 넣지 않는 이유는 이 저장소가 react-router·react-query를 넣지 않은 것과 같다 —
 * 필요한 것은 선 하나, 축 두 개, 호버 툴팁뿐인데 recharts는 수백 KB를 가져온다.
 *
 * 다만 직접 그릴 때 반드시 해야 하는 것들이 있고, 그걸 빼면 라이브러리보다 나쁜 차트가 된다:
 *  - 값의 범위에 여백을 준다. 딱 맞추면 선이 테두리에 붙어 읽기 어렵다.
 *  - 모든 값이 같을 때 0으로 나누지 않는다.
 *  - x축 라벨을 솎아낸다. 300개 시점을 다 그리면 글자가 겹쳐 아무것도 안 보인다.
 *  - 결측을 선으로 잇지 않는다. 이으면 없는 데이터를 있는 것처럼 보여준다.
 */
export interface Point {
  period: string;
  avg_value: number | null;
  min_value?: number | null;
  max_value?: number | null;
  n?: number;
}

const W = 720;
const H = 260;
const PAD = { top: 16, right: 16, bottom: 34, left: 56 };

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(1)}조`;
  if (abs >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(1)}만`;
  if (abs >= 100) return v.toFixed(0);
  return v.toFixed(2).replace(/\.?0+$/, "");
}

export function LineChart({ points, unit }: { points: Point[]; unit?: string | null }) {
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const valid = points.filter((p) => p.avg_value !== null && Number.isFinite(p.avg_value));
    if (valid.length === 0) return null;
    const values = valid.map((p) => p.avg_value as number);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (lo === hi) {
      // 상수 시계열. 0으로 나누지 않도록 인위적 폭을 준다.
      const pad = Math.abs(lo) * 0.1 || 1;
      lo -= pad;
      hi += pad;
    } else {
      const pad = (hi - lo) * 0.08;
      lo -= pad;
      hi += pad;
    }
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;

    // 결측 구간에서 선을 끊는다 (M으로 다시 시작).
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      if (p.avg_value === null || !Number.isFinite(p.avg_value)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.avg_value).toFixed(1)} `;
      pen = true;
    });

    // x 라벨 개수는 **라벨 길이에 따라** 정한다.
    // 고정 8개로 두면 '2024' (4자)는 넉넉하지만 '1999-01-01 00:00' (16자)는 서로 겹쳐
    // 아무것도 읽을 수 없다 — 해양관측(10분 간격)을 넣자마자 그렇게 됐다.
    const labelChars = Math.max(...points.map((p) => p.period.length));
    const charW = 5.6; // fontSize 10 기준 대략적인 글자 폭

    // 필요한 라벨 간 간격.
    //
    // 첫 라벨은 접두사를 떼지 않아 전체 길이이고 왼쪽 정렬(start)이라 오른쪽으로 뻗는다.
    // 나머지는 가운데 정렬(middle)이라 자기 위치에서 **왼쪽으로도** 절반이 파고든다.
    // 이 절반을 계산에 넣지 않으면 첫 라벨과 두 번째 라벨이 겹친다 —
    // 375px 화면에서 '1999-01-01 00:00'과 '03 19:00'이 실제로 겹쳤다.
    //
    // 축약 후 길이를 미리 알 수 없으므로 최악(축약 없음)으로 잡는다.
    // 라벨이 몇 개 줄어드는 손해가, 겹쳐서 못 읽는 것보다 낫다.
    const fullW = labelChars * charW;
    const needed = fullW * 1.5 + 8;
    const maxLabels = Math.max(2, Math.floor(innerW / needed));
    const stride = Math.max(1, Math.ceil(points.length / maxLabels));

    // 모든 라벨이 같은 접두사를 공유하면(예: 전부 '1999-01-') 그 부분은 정보가 없다.
    // 첫 라벨에만 전체를 보여주고 나머지는 공통 부분을 떼어 읽기 쉽게 만든다.
    const shown = points.map((p, i) => ({ i, period: p.period })).filter(({ i }) => i % stride === 0);
    let common = 0;
    if (shown.length > 1) {
      const first = shown[0]!.period;
      while (
        common < first.length &&
        shown.every((l) => l.period[common] === first[common])
      ) common++;
      // 날짜 구분자 중간에서 자르지 않는다. 마지막 구분자까지만 뗀다.
      const cut = Math.max(
        first.lastIndexOf("-", common - 1),
        first.lastIndexOf(" ", common - 1),
        first.lastIndexOf(":", common - 1),
      );
      common = cut > 0 ? cut + 1 : 0;
    }
    const labels = shown.map((l, idx) => ({
      i: l.i,
      period: idx === 0 || common === 0 ? l.period : l.period.slice(common),
    }));
    return { x, y, d, lo, hi, labels, ticks: niceTicks(lo, hi), prefix: common > 0 ? shown[0]!.period.slice(0, common) : "" };
  }, [points]);

  if (!model) {
    return <div className="muted small" style={{ padding: 24 }}>표시할 수치가 없습니다 (전부 결측).</div>;
  }

  // 스크린리더용 요약. "선 그래프"라고만 말하면 아무 도움이 안 되므로
  // 기간·범위·시작과 끝 값처럼 그래프를 보고 알 수 있는 것을 문장으로 준다.
  const valid = points.filter((p) => p.avg_value !== null && Number.isFinite(p.avg_value));
  const first = valid[0];
  const last = valid.at(-1);
  const lows = valid.map((p) => p.avg_value as number);
  const summary =
    first && last
      ? `시계열 선 그래프. ${first.period}부터 ${last.period}까지 ${valid.length}개 시점. ` +
        `${fmt(first.avg_value as number)}에서 시작해 ${fmt(last.avg_value as number)}로 끝남. ` +
        `최저 ${fmt(Math.min(...lows))}, 최고 ${fmt(Math.max(...lows))}${unit ? ` (단위 ${unit})` : ""}.`
      : "시계열 선 그래프 (데이터 없음)";

  const hovered = hover !== null ? points[hover] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        // 선 그래프는 스크린리더에 아무 정보도 주지 못한다.
        // 이미지로 취급하고 요약을 이름으로 준다 — 아래 표(sr-only)가 실제 수치를 제공한다.
        role="img"
        aria-label={summary}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const innerW = W - PAD.left - PAD.right;
          const ratio = (px - PAD.left) / innerW;
          const idx = Math.round(ratio * (points.length - 1));
          setHover(idx >= 0 && idx < points.length ? idx : null);
        }}
      >
        {model.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={model.y(t)} y2={model.y(t)}
                  stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.left - 8} y={model.y(t)} textAnchor="end" dominantBaseline="middle"
                  fontSize={10} fill="var(--text-muted)">{fmt(t)}</text>
          </g>
        ))}
        {model.labels.map(({ i, period }, idx) => (
          <text
            key={i}
            x={model.x(i)}
            y={H - PAD.bottom + 16}
            // 첫 라벨은 전체 문자열이라 길다. 가운데 정렬하면 왼쪽으로 삐져나간다.
            textAnchor={idx === 0 ? "start" : "middle"}
            fontSize={10}
            fill="var(--text-muted)"
          >
            {period}
          </text>
        ))}
        <path d={model.d} fill="none" stroke="var(--accent)" strokeWidth={1.8}
              strokeLinejoin="round" strokeLinecap="round" />
        {hovered && hovered.avg_value !== null && (
          <>
            <line x1={model.x(hover!)} x2={model.x(hover!)} y1={PAD.top} y2={H - PAD.bottom}
                  stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={model.x(hover!)} cy={model.y(hovered.avg_value)} r={3.5} fill="var(--accent)" />
          </>
        )}
      </svg>
      {/*
        시각적 차트를 읽을 수 없는 사용자를 위한 실제 수치.
        요약만으로는 특정 시점의 값을 알 수 없다. 화면에는 보이지 않지만 읽힌다.
        전체를 넣으면 수백 행이 되므로 라벨이 붙은 지점만 넣는다 —
        차트에서 눈금으로 읽을 수 있는 것과 같은 정보량이다.
      */}
      <table className="sr-only">
        <caption>{summary}</caption>
        <thead>
          <tr><th scope="col">시점</th><th scope="col">값{unit ? ` (${unit})` : ""}</th></tr>
        </thead>
        <tbody>
          {model.labels.map(({ i }) => {
            const p = points[i];
            if (!p || p.avg_value === null) return null;
            return (
              <tr key={i}>
                <th scope="row">{p.period}</th>
                <td>{fmt(p.avg_value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {hovered && hovered.avg_value !== null && (
        <div className="card small" style={{ position: "absolute", top: 0, right: 0, padding: "6px 10px" }}>
          <strong>{hovered.period}</strong>{" "}
          <span className="mono">{fmt(hovered.avg_value)}</span>
          {unit && <span className="muted"> {unit}</span>}
          {hovered.n !== undefined && <div className="muted">{hovered.n.toLocaleString()}개 관측 평균</div>}
        </div>
      )}
    </div>
  );
}
