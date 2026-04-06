#version 300 es
precision highp float;

in vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_mouthOpenness;
uniform vec2 u_mouthCenter;

out vec4 fragColor;

void main() {
    vec4 texColor = texture(u_texture, v_texCoord);

    // Mouth interior darkening when mouth is open
    float dist = distance(v_texCoord, u_mouthCenter);
    float mouthRadius = 0.08 * u_mouthOpenness;
    float darkness = smoothstep(mouthRadius, mouthRadius * 0.3, dist);

    vec3 mouthInterior = vec3(0.08, 0.04, 0.03);
    vec3 teeth = vec3(0.85, 0.82, 0.78);

    // Upper 1/3 of mouth shows teeth hint
    float teethBand = smoothstep(
        u_mouthCenter.y - mouthRadius * 0.4,
        u_mouthCenter.y - mouthRadius * 0.1,
        v_texCoord.y
    );
    vec3 interior = mix(teeth, mouthInterior, teethBand);
    vec3 finalColor = mix(interior, texColor.rgb, 1.0 - darkness * u_mouthOpenness);

    fragColor = vec4(finalColor, 1.0);
}
