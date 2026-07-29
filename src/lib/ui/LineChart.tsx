import {
  CartesianGrid,
  Legend,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export interface SeriesDef {
  key: string
  name: string
  color: string
  yAxisId?: 'left' | 'right'
}

export function LineChart({
  data,
  series,
  xKey = 't',
  height = 220,
  dualAxis = false,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: ReadonlyArray<Record<string, any>>
  series: SeriesDef[]
  xKey?: string
  height?: number
  dualAxis?: boolean
}) {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <RLineChart data={data} margin={{ top: 8, right: dualAxis ? 16 : 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#243049" strokeDasharray="3 3" />
          <XAxis dataKey={xKey} stroke="#9aa8c7" tick={{ fontSize: 11 }} />
          <YAxis yAxisId="left" stroke="#9aa8c7" tick={{ fontSize: 11 }} width={40} />
          {dualAxis && <YAxis yAxisId="right" orientation="right" stroke="#9aa8c7" tick={{ fontSize: 11 }} width={40} />}
          <Tooltip
            contentStyle={{
              background: '#141b2d',
              border: '1px solid #2a3550',
              borderRadius: 8,
            }}
          />
          <Legend />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              yAxisId={s.yAxisId ?? 'left'}
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </RLineChart>
      </ResponsiveContainer>
    </div>
  )
}
