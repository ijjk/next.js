import Link from 'next/link'

export default function Index() {
  return (
    <>
      <p id="index">index page</p>
      <Link href="/another" as="//google.com">
        <a id="page-with-as-slashes">to /another as //google.com</a>
      </Link>
      <br />

      <Link href="//google.com">
        <a id="href-with-slashes">to //google.com</a>
      </Link>
      <br />

      <Link href="//google.com?hello=1">
        <a id="href-with-slashes-query">to //google.com?hello=1</a>
      </Link>
      <br />

      <Link href="//google.com#hello">
        <a id="href-with-slashes-hash">to //google.com#hello</a>
      </Link>
      <br />
    </>
  )
}
