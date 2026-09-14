# Personal Jira attachment readback

The live personal CCC trial uploaded a PDF successfully, then received HTTP 406
when requesting its content with `Accept: application/octet-stream`. Download
now accepts the service's media type with `Accept: */*`. Existing metadata MIME,
byte count, hash, redirect-origin and credential-stripping checks remain enforced.

The focused reproduction failed before the correction. All 20 attachment tests
passed afterward. Actual download recovery is the next live check; this record
does not claim that the full Jira or provider workflow has passed.

The Coordinator compares the bridge entry point with its exact Git blob. Pin
that file to LF in `.gitattributes` so Windows checkout conversion cannot reject
an otherwise clean deployment. The installed work bridge is unchanged.
