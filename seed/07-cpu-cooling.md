# CPU cooling notes

## Air versus AIO

I've run both. The summary I'd give someone: a good dual-tower air cooler and a 360 mm
all-in-one liquid cooler perform close enough that the decision should be made on the other
factors, not on the temperature chart.

**Air — arguments for:**

- No pump. The pump is the only component in an AIO that fails outright, and when it fails
  the CPU goes from fine to thermal shutdown in seconds.
- The fan blows across the motherboard's VRM heatsinks and the memory. An AIO leaves that
  whole area in still air, which matters on a board with marginal VRM cooling — see the
  motherboard note.
- Cheaper, quieter at equivalent dissipation, and it will outlive the platform.

**AIO — arguments for:**

- Moves the heat to the case wall instead of dumping it in the middle of the case, which
  helps the graphics card underneath.
- Clears tall memory and cramped cases where a 160 mm tower simply won't fit.
- With a 360 mm radiator, higher absolute ceiling for a very hot chip.

I run air on the desktop. The deciding argument was the pump failure mode, not the
temperatures.

## Rated wattage is measured optimistically

Cooler ratings ("suitable up to 250 W") assume an open bench, an ambient in the low twenties,
and the fan at maximum. In a closed case at 26 °C with a quiet fan curve, expect meaningfully
less. I size for the CPU's **PPT or PL2** — the real sustained ceiling from my CPU note — and
then add margin, rather than sizing for the rated TDP.

The mistake I made once: a "150 W" cooler on a 142 W PPT chip. Adequate on paper, throttling
in practice on a warm afternoon.

## Thermal paste

Far less critical than the internet suggests, with one exception.

- Application method barely matters. A pea in the centre, five dots, a thin spread — all
  within a degree or two of each other. Do not overthink it.
- Amount matters slightly: too little leaves gaps, too much is merely messy since the excess
  squeezes out.
- **Pump-out is the real issue.** Thermal cycling gradually pushes paste out from between the
  cooler and the heat spreader, and temperatures creep up over one to three years. Repasting
  every couple of years recovers it. This is the actual reason to keep a tube around, not the
  application pattern.
- Liquid metal has genuinely better conductivity and is electrically conductive, attacks
  aluminium, and will destroy a card or board if it escapes. Not on a machine I rely on.

## Mounting pressure and contact

Uneven mounting costs more degrees than any paste choice. Tighten the mounting screws in a
diagonal pattern, a couple of turns at a time, until they stop — the springs set the pressure,
so "until it stops" is correct rather than "until it feels tight".

On Intel LGA 1700 specifically, the retention mechanism bends the heat spreader slightly
concave, which leaves the centre of the die under-contacted. Aftermarket contact frames
replace the stock bracket and typically recover 5–10 °C. Worth doing on that socket; not a
thing on AM5.

## Fan curves

The default curves ship aggressive because vendors are optimising for review temperatures,
not for living with the machine.

What I set:

- Nothing spinning below about 50 °C. Silence at idle is most of the perceived improvement.
- A gentle ramp between 50 and 75 °C.
- Steep above 80 °C.
- **Long hysteresis** — several seconds of averaging. The single biggest quality-of-life
  change is stopping the fan from responding to momentary spikes. A fan that ramps up and
  down every few seconds is far more irritating than a fan running steadily at a higher speed.

Tie the CPU fan to the CPU sensor and the case fans to a motherboard or water temperature
sensor. Case fans chasing the CPU sensor produce exactly the surging noise described above,
because the CPU temperature moves faster than case air possibly can.

## Dust

Cooling degrades gradually and nobody notices, because it happens over months. A fin stack
clogged with dust loses a lot of its surface area. Compressed air every six months, fan held
still with a finger so it isn't spun beyond its bearing's rated speed.

Radek Pokorný (radek.pokorny@example.com) makes the point that the filters are only useful if
they're cleaned — a clogged filter is worse than no filter, because it starves the intake and
flips the case to negative pressure, which pulls unfiltered dust through every gap instead.
More on that in the case and airflow note.
