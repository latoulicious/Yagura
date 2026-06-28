import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import type { Tone } from '../api'

// Stroke per tone — healthy stays calm (text-tertiary); only a broken tone tints.
const STROKE: Record<Tone, string> = {
  healthy: 'var(--color-text-3)',
  degraded: 'var(--color-degraded)',
  offline: 'var(--color-offline)',
  unknown: 'var(--color-unknown)',
}

// One sparkline for host, probe, and container rows. Full-width — the wrapper
// sizes it (flex-1 or fixed); ResponsiveContainer redraws to 100%.
// Area chart: 1.5px stroke, 10% opacity fill (visual-design §Sparklines).
export function Sparkline({ data, tone = 'healthy' }: { data: number[]; tone?: Tone }) {
  if (data.length < 2) return <div className="h-6 w-full" />
  return (
    <div className="h-6 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data.map((v) => ({ v }))}>
          <Area
            type="monotone"
            dataKey="v"
            dot={false}
            stroke={STROKE[tone]}
            strokeWidth={1.5}
            fill={STROKE[tone]}
            fillOpacity={0.1}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
