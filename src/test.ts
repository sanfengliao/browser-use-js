class A {
  a?: number
  constructor() {

  }

  getA() {
    return this.a
  }
}

class B extends A {
  a = 1
  constructor() {
    super()
  }
}
console.log(Object.keys(new A()))
console.log({ ...new A() })
console.log(JSON.stringify(new A()))

console.log(new B().getA())
