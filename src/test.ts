let a = [1, 2, 3, 4, 5]

for (const value of a) {
  if (value === 3) {
    a = undefined
  }
  console.log(value)
}

console.log(a)
// for (const [index, value] of a.entries()) {
//   console.log(index, value)
// }

console.log(JSON.stringify({ a: undefined, b: { c: 1 } }, null, 2))
