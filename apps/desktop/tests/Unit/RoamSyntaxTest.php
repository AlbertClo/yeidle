<?php

namespace Tests\Unit;

use App\Import\Roam\RoamSyntax;
use PHPUnit\Framework\TestCase;

class RoamSyntaxTest extends TestCase
{
    public function test_page_reference_count_excludes_code_and_roam_component_names(): void
    {
        $source = <<<'ROAM'
```css
/* Colors from [[Dracula Pro]] */
```
`[[Inline example]]`
{{[[video]]: https://files.test/example.mp4}}
{{ [[query]]: {and: [[Included Query Argument]]} }}
[[Actual Page]]
ROAM;

        $this->assertSame(2, RoamSyntax::pageReferenceCount($source));
    }
}
